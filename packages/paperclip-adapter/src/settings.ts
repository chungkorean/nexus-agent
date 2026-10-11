import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandSpec } from "@nexus/shared";

export const ADAPTER_TYPE = "nexus_dispatch";

/** Paperclip 에이전트 설정(adapterConfig)에서 읽는 값 */
export interface DispatchSettings {
  cwd: string | null;
  nonCodingAgentId: string | null;
  configDir: string;
  opencodeCommand: CommandSpec;
  claudeCommand: CommandSpec;
  timeoutSec: number;
  markDoneOnSuccess: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function command(v: unknown, fallback: string): CommandSpec {
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
  return str(v) ?? fallback;
}

/** 사용자가 고치는 설정 폴더. Windows는 %LOCALAPPDATA%\Nexus\config */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEXUS_CONFIG_DIR) return env.NEXUS_CONFIG_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Nexus", "config");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "nexus");
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
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : 1800,
    markDoneOnSuccess: config.markDoneOnSuccess === true,
  };
}
