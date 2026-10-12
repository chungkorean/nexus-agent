// 계정 로그인 창 열기. 계정마다 로그인 폴더를 따로 두므로 환경 변수로 폴더를 넘겨 실행한다.
import { spawn } from "node:child_process";
import type { Account, Engine } from "@nexus/shared";

export interface LoginCommand {
  accountId: string;
  engine: Engine;
  command: string;
  args: string[];
  /** 새 창에 더해 넘길 환경 변수 (로그인 폴더) */
  env: Record<string, string>;
}

export interface LaunchResult {
  /** 창을 실제로 열었으면 true. false면 commandText를 사용자에게 보여 준다. */
  launched: boolean;
  commandText?: string;
  error?: string;
}

/**
 * antigravityScript: Windows에서 Antigravity CLI가 없으면 설치부터 하고 agy를 여는 스크립트.
 * 다른 운영체제에서는 agy를 그대로 실행한다.
 */
export function buildLoginCommand(account: Pick<Account, "id" | "engine" | "dir">, o: { antigravityScript?: string; platform?: NodeJS.Platform } = {}): LoginCommand {
  if (account.engine === "antigravity") {
    // agy는 로그인 정보를 운영체제 자격 증명 저장소에 두므로 폴더를 넘기지 않는다.
    const useScript = (o.platform ?? process.platform) === "win32" && o.antigravityScript;
    return { accountId: account.id, engine: account.engine, command: useScript ? o.antigravityScript! : "agy", args: [], env: {} };
  }
  if (account.engine === "claude-code") {
    return { accountId: account.id, engine: account.engine, command: "claude", args: [], env: { CLAUDE_CONFIG_DIR: account.dir } };
  }
  return { accountId: account.id, engine: account.engine, command: "opencode", args: ["auth", "login"], env: { XDG_DATA_HOME: account.dir } };
}

function shQuote(s: string): string {
  return /^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Windows가 아닐 때 사용자가 터미널에 붙여 넣을 명령 */
export function commandText(cmd: LoginCommand, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const sets = Object.entries(cmd.env).map(([k, v]) => `set "${k}=${v}"`);
    return [...sets, [cmd.command, ...cmd.args].join(" ")].join(" && ");
  }
  const env = Object.entries(cmd.env).map(([k, v]) => `${k}=${shQuote(v)}`);
  return [...env, cmd.command, ...cmd.args.map(shQuote)].join(" ");
}

/**
 * 기본 실행기. Windows에서는 새 명령 프롬프트 창을 열어 로그인 명령을 실행한다.
 * 환경 변수는 spawn의 env로 넘기므로 따옴표 처리 문제가 없다.
 */
export function defaultLauncher(cmd: LoginCommand): Promise<LaunchResult> {
  if (process.platform !== "win32") return Promise.resolve({ launched: false, commandText: commandText(cmd, process.platform) });
  // 경로에 빈칸이 있으면(예: C:\Users\홍 길동) 따옴표로 묶는다.
  const inner = [/\s/.test(cmd.command) ? `"${cmd.command}"` : cmd.command, ...cmd.args].join(" ");
  return new Promise((resolve) => {
    try {
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"start "Nexus 로그인" cmd /k ${inner}"`], {
        env: { ...process.env, ...cmd.env },
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsVerbatimArguments: true,
        windowsHide: false,
      });
      child.once("error", (err) => resolve({ launched: false, commandText: commandText(cmd, "win32"), error: err.message }));
      child.once("spawn", () => {
        child.unref();
        resolve({ launched: true });
      });
    } catch (err) {
      resolve({ launched: false, commandText: commandText(cmd, "win32"), error: (err as Error).message });
    }
  });
}
