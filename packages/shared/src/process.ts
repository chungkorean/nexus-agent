import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

/** "opencode" 같은 실행 파일 이름, 또는 ["node", "fake.mjs"]처럼 앞에 붙일 인수까지 포함한 배열 */
export type CommandSpec = string | string[];

export function splitCommand(cmd: CommandSpec): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("빈 명령이에요");
    return [head, rest];
  }
  return [cmd, []];
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  /** 부모 프로세스 환경에서 지울 변수. 예: 구독 계정으로 돌릴 때 ANTHROPIC_API_KEY */
  unsetEnv?: string[];
  stdin?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: Error;
}

/**
 * Windows에서도 .cmd 실행 파일(claude.cmd 등)을 찾도록 cross-spawn으로 띄운다.
 * 시간 초과나 취소 시에는 자식 프로세스까지 함께 종료한다.
 */
export function startProcess(cmd: CommandSpec, args: string[], opts: Omit<SpawnOptions, "timeoutSec" | "signal" | "stdin">): ChildProcess {
  const [command, prefix] = splitCommand(cmd);
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  for (const key of opts.unsetEnv ?? []) delete env[key];
  return crossSpawn(command, [...prefix, ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // POSIX에서는 프로세스 그룹을 만들어 그룹째 종료한다. Windows는 taskkill /T를 쓴다.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

/**
 * 프로세스 트리를 끝내고 실제로 끝날 때까지 기다린다(최대 waitMs).
 * Windows는 실행 중인 프로세스의 작업 폴더를 지울 수 없어서, 폴더 정리 전에 꼭 기다려야 한다.
 */
export async function stopTree(child: ChildProcess, waitMs = 10_000): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let killer: Promise<void> = Promise.resolve();
  if (process.platform === "win32") {
    killer = new Promise<void>((resolve) => {
      const tk = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.once("close", () => resolve());
      tk.once("error", () => resolve());
    });
  } else {
    killTree(child);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  await Promise.race([Promise.all([exited, killer]), timeout]);
  if (timer) clearTimeout(timer);
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* 이미 종료됨 */
    }
  }, 5_000);
  timer.unref();
}

export function runProcess(cmd: CommandSpec, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = startProcess(cmd, args, opts);
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: err as Error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer =
      opts.timeoutSec && opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, opts.timeoutSec * 1000)
        : null;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      void opts.onLog?.("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      void opts.onLog?.("stderr", chunk);
    });

    const finish = (result: Partial<SpawnResult>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, aborted, ...result });
    };
    child.on("error", (err) => finish({ spawnError: err }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));

    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}
