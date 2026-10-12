import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAccountsDir, defaultAgyCommand, defaultConfigDir, defaultStateDir, defaultWorktreeRoot, type CommandSpec, type ResultPolicy } from "@nexus/shared";

export { defaultConfigDir };

export const ADAPTER_TYPE = "nexus_dispatch";

/** Paperclip 에이전트 설정(adapterConfig)에서 읽는 값 */
export interface DispatchSettings {
  cwd: string | null;
  nonCodingAgentId: string | null;
  configDir: string;
  opencodeCommand: CommandSpec;
  claudeCommand: CommandSpec;
  /** Google 계정(Gemini 구독)용 Antigravity CLI */
  agyCommand: CommandSpec;
  /** 풀 리퀘스트를 만들 때 쓰는 GitHub CLI */
  ghCommand: CommandSpec;
  timeoutSec: number;
  markDoneOnSuccess: boolean;
  /** 하위 작업이 모두 성공하면 브랜치를 작업 폴더의 현재 브랜치에 자동으로 합칠지 */
  autoMerge: boolean;
  /** 계정 한도 상태 파일을 두는 폴더 */
  stateDir: string;
  /** 계정 로그인 폴더의 상위 폴더 (accounts.yaml에서 dir을 비운 계정) */
  accountsDir: string;
  /** 병렬 실행용 worktree 폴더 */
  worktreeRoot: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function bool(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

/**
 * 결과 처리 설정: Paperclip 에이전트 설정에 값이 있으면 그것을, 없으면 Nexus 설정 화면(routing.yaml results)의 값을 쓴다.
 */
export function withResultPolicy(s: DispatchSettings, config: Record<string, unknown>, policy: Pick<ResultPolicy, "autoMerge" | "markDoneOnSuccess">): DispatchSettings {
  return {
    ...s,
    autoMerge: bool(config.autoMerge) ?? policy.autoMerge,
    markDoneOnSuccess: bool(config.markDoneOnSuccess) ?? policy.markDoneOnSuccess,
  };
}

function command(v: unknown, fallback: string): CommandSpec {
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
  return str(v) ?? fallback;
}

/** 어댑터 패키지에 함께 들어 있는 기본 설정 폴더. 사용자 설정 파일이 없을 때 쓴다. */
export function bundledConfigDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "..", "..", "config"), path.join(here, "..", "config"), path.join(here, "..", "..", "..", "..", "config")]) {
    if (existsSync(path.join(candidate, "models.yaml"))) return candidate;
  }
  return undefined;
}

export function readSettings(config: Record<string, unknown>, context: Record<string, unknown> = {}): DispatchSettings {
  const workspace = (context.paperclipWorkspace ?? context.workspace) as { cwd?: unknown } | undefined;
  const timeout = Number(config.timeoutSec);
  return {
    cwd: str(config.cwd) ?? str(workspace?.cwd) ?? null,
    nonCodingAgentId: str(config.nonCodingAgentId),
    configDir: str(config.configDir) ?? defaultConfigDir(),
    opencodeCommand: command(config.opencodeCommand, "opencode"),
    claudeCommand: command(config.claudeCommand, "claude"),
    agyCommand: command(config.agyCommand, defaultAgyCommand()),
    ghCommand: command(config.ghCommand, "gh"),
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : 1800,
    markDoneOnSuccess: bool(config.markDoneOnSuccess) ?? true,
    autoMerge: bool(config.autoMerge) ?? true,
    stateDir: str(config.stateDir) ?? defaultStateDir(),
    accountsDir: str(config.accountsDir) ?? defaultAccountsDir(),
    worktreeRoot: str(config.worktreeRoot) ?? defaultWorktreeRoot(),
  };
}
