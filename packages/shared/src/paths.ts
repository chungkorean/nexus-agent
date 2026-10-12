import os from "node:os";
import path from "node:path";

/** Nexus가 쓰는 폴더의 기준. Windows는 %LOCALAPPDATA%\Nexus, 그 밖은 ~/.local/share/nexus 계열 */
function baseDir(env: NodeJS.ProcessEnv): string {
  if (env.NEXUS_HOME) return env.NEXUS_HOME;
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Nexus");
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "nexus");
}

/** Nexus 기본 폴더 (%LOCALAPPDATA%\Nexus) */
export function nexusHome(env: NodeJS.ProcessEnv = process.env): string {
  return baseDir(env);
}

/** 사용자가 고치는 설정 폴더 (models.yaml, routing.yaml, accounts.yaml) */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEXUS_CONFIG_DIR) return env.NEXUS_CONFIG_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Nexus", "config");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "nexus");
}

/** 계정 한도 상태처럼 프로그램이 쓰는 파일 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXUS_STATE_DIR ?? path.join(baseDir(env), "state");
}

/** 계정별 로그인 폴더의 상위 폴더 */
export function defaultAccountsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(baseDir(env), "accounts");
}

/** 병렬 실행용 git worktree를 만드는 곳. Windows 긴 경로 문제를 피하려고 짧게 둔다. */
export function defaultWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXUS_WORKTREE_ROOT ?? path.join(baseDir(env), "wt");
}
