import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runProcess, type CommandSpec } from "@nexus/shared";

export interface TestRun {
  /** passed: 통과, failed: 실패, unavailable: 테스트 도구가 없어 못 돌림, none: 테스트를 찾지 못함 */
  status: "passed" | "failed" | "unavailable" | "none";
  command?: string;
  /** 출력 끝부분 */
  output?: string;
  durationSec?: number;
}

/** 프로젝트 폴더를 보고 테스트 명령을 고른다. 못 찾으면 null */
export function detectTestCommand(dir: string): string | null {
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/i.test(test)) {
        if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm test";
        if (existsSync(path.join(dir, "yarn.lock"))) return "yarn test";
        return "npm test";
      }
    } catch {
      /* 읽지 못하면 다른 방법으로 찾는다 */
    }
  }
  if (hasPythonTests(dir)) return "python -m pytest -q";
  return null;
}

function hasPythonTests(dir: string): boolean {
  if (["pytest.ini", "conftest.py", "tox.ini"].some((f) => existsSync(path.join(dir, f)))) return true;
  for (const f of ["pyproject.toml", "setup.cfg"]) {
    const p = path.join(dir, f);
    if (existsSync(p) && /pytest/.test(readFileSync(p, "utf8"))) return true;
  }
  const isTestFile = (name: string) => /^test_.*\.py$|_test\.py$/.test(name);
  const list = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  if (list(dir).some(isTestFile)) return true;
  return list(path.join(dir, "tests")).some(isTestFile);
}

/** 테스트 도구 자체가 없을 때의 출력 (실패로 보지 않는다) */
const UNAVAILABLE = /No module named pytest|Python was not found|is not recognized as an internal or external command|command not found|not found: (npm|pnpm|yarn|python)|ENOENT/i;

export function shellCommand(command: string): { cmd: CommandSpec; args: string[] } {
  return process.platform === "win32" ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", command] } : { cmd: "sh", args: ["-c", command] };
}

export async function runTests(dir: string, configured: string, opts: { timeoutSec: number; signal?: AbortSignal }): Promise<TestRun> {
  const command = configured || detectTestCommand(dir);
  if (!command) return { status: "none" };
  const started = Date.now();
  const { cmd, args } = shellCommand(command);
  const res = await runProcess(cmd, args, { cwd: dir, timeoutSec: opts.timeoutSec, signal: opts.signal, env: { CI: "1" } });
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(-3000);
  const durationSec = Math.round((Date.now() - started) / 1000);
  if (res.spawnError) return { status: "unavailable", command, output: res.spawnError.message, durationSec };
  if (res.exitCode === 0) return { status: "passed", command, output, durationSec };
  // pytest 5: 모은 테스트가 없음
  if (command.includes("pytest") && res.exitCode === 5) return { status: "none", command, output, durationSec };
  // 127: POSIX 셸에서 명령 없음, 9009: Windows cmd에서 명령 없음
  if (res.exitCode === 127 || res.exitCode === 9009 || (UNAVAILABLE.test(output) && !res.timedOut)) return { status: "unavailable", command, output, durationSec };
  return { status: "failed", command, output: res.timedOut ? `시간 초과로 멈췄어요.\n${output}` : output, durationSec };
}
