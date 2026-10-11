import { existsSync, statSync } from "node:fs";
import { ConfigError, loadConfig, runProcess, type CommandSpec } from "@nexus/shared";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "../adapter-types.ts";
import { ADAPTER_TYPE, bundledConfigDir, readSettings } from "../settings.ts";

/** Paperclip 에이전트 설정 화면의 "환경 점검" 버튼이 부르는 함수 */
export async function testDispatchEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const s = readSettings(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];

  if (!s.cwd) {
    checks.push({ code: "cwd_missing", level: "error", message: "작업 폴더(cwd)가 설정되지 않았어요.", hint: "에이전트 설정에 작업할 폴더의 전체 경로를 넣어 주세요." });
  } else if (!existsSync(s.cwd) || !statSync(s.cwd).isDirectory()) {
    checks.push({ code: "cwd_not_found", level: "error", message: `작업 폴더가 없어요: ${s.cwd}` });
  } else {
    checks.push({ code: "cwd_ok", level: "info", message: `작업 폴더: ${s.cwd}` });
  }

  let usesOpenCode = true;
  let usesClaude = true;
  try {
    const config = loadConfig(s.configDir, bundledConfigDir());
    const engines = new Set(Object.values(config.aliases).map((a) => a.engine));
    usesOpenCode = engines.has("opencode");
    usesClaude = engines.has("claude-code");
    checks.push({ code: "config_ok", level: "info", message: `설정 파일을 읽었어요 (별칭 ${Object.keys(config.aliases).length}개)`, detail: s.configDir });
  } catch (err) {
    checks.push({
      code: "config_invalid",
      level: "error",
      message: err instanceof ConfigError ? "설정 파일에 문제가 있어요." : "설정 파일을 읽지 못했어요.",
      detail: (err as Error).message,
    });
  }

  if (usesOpenCode) checks.push(await probe("opencode", s.opencodeCommand, s.cwd));
  if (usesClaude) checks.push(await probe("claude", s.claudeCommand, s.cwd));
  if (!s.nonCodingAgentId) {
    checks.push({ code: "no_delegate", level: "warn", message: "비코딩 작업을 넘길 에이전트(nonCodingAgentId)가 없어요. 비코딩 이슈도 직접 실행합니다." });
  }

  const status = checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
  return { adapterType: ADAPTER_TYPE, status, checks, testedAt: new Date().toISOString() };
}

async function probe(name: string, cmd: CommandSpec, cwd: string | null): Promise<AdapterEnvironmentCheck> {
  const res = await runProcess(cmd, ["--version"], { cwd: cwd && existsSync(cwd) ? cwd : process.cwd(), timeoutSec: 20 });
  if (res.spawnError || res.exitCode !== 0) {
    return {
      code: `${name}_missing`,
      level: "error",
      message: `${name}을 실행하지 못했어요.`,
      detail: res.spawnError?.message ?? res.stderr.slice(-300),
      hint: name === "claude" ? "Claude Code를 설치하고 claude 로그인을 마쳐 주세요." : "OpenCode를 설치하고 opencode에서 공급자 로그인을 마쳐 주세요.",
    };
  }
  return { code: `${name}_ok`, level: "info", message: `${name} ${res.stdout.trim().split(/\r?\n/)[0] ?? ""}`.trim() };
}
