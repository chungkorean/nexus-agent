import { existsSync, statSync } from "node:fs";
import { AccountState, accountHasLogin, ConfigError, loadConfig, runProcess, type CommandSpec } from "@nexus/shared";
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
  let usesAgy = false;
  try {
    const config = loadConfig(s.configDir, bundledConfigDir(), s.accountsDir);
    const engines = new Set(Object.values(config.aliases).map((a) => a.engine));
    usesOpenCode = engines.has("opencode");
    usesClaude = engines.has("claude-code");
    usesAgy = engines.has("antigravity");
    checks.push({ code: "config_ok", level: "info", message: `설정 파일을 읽었어요 (별칭 ${Object.keys(config.aliases).length}개)`, detail: s.configDir });
    const state = new AccountState(s.stateDir);
    for (const acc of Object.values(config.accounts)) {
      const cooldown = state.get(acc.id);
      if (!accountHasLogin(acc)) {
        checks.push({ code: "account_not_logged_in", level: "warn", message: `계정 ${acc.label}: 아직 로그인하지 않았어요.`, detail: acc.dir, hint: "설정 화면(pnpm settings)의 계정 칸에서 로그인 창을 열어 주세요." });
      } else if (cooldown) {
        checks.push({ code: "account_cooling_down", level: "warn", message: `계정 ${acc.label}: ${new Date(cooldown.until).toLocaleString("ko-KR")}까지 쉬는 중 (${cooldown.reason})` });
      } else {
        checks.push({ code: "account_ok", level: "info", message: `계정 ${acc.label}: 사용 가능` });
      }
    }
    const modeLabel = { auto: "큰 이슈만", always: "항상", never: "안 함" }[config.routing.planning.mode];
    checks.push({ code: "planning", level: "info", message: `작업 나누기: ${modeLabel}, 동시 실행 ${config.routing.planning.concurrency}개` });
    const res = config.routing.results;
    if (res.githubPush && s.cwd && existsSync(s.cwd)) {
      const remote = await runProcess("git", ["remote", "get-url", res.githubRemote], { cwd: s.cwd, timeoutSec: 20 });
      checks.push(
        remote.exitCode === 0
          ? { code: "github_remote_ok", level: "info", message: `GitHub에 올릴 저장소: ${remote.stdout.trim()}` }
          : { code: "github_remote_missing", level: "warn", message: `GitHub 연동이 켜져 있지만 작업 폴더에 원격 저장소(${res.githubRemote})가 없어요.`, hint: `작업 폴더에서 git remote add ${res.githubRemote} <저장소 주소>를 실행하거나 설정 화면에서 GitHub 연동을 꺼 주세요.` },
      );
      if (res.githubPullRequest) {
        const gh = await runProcess(s.ghCommand, ["auth", "status"], { cwd: s.cwd, timeoutSec: 20 });
        if (gh.spawnError) checks.push({ code: "gh_missing", level: "warn", message: "풀 리퀘스트를 만들 GitHub CLI(gh)가 없어요.", hint: "https://cli.github.com 에서 설치한 뒤 gh auth login을 해 주세요." });
        else if (gh.exitCode !== 0) checks.push({ code: "gh_not_logged_in", level: "warn", message: "GitHub CLI(gh)에 로그인되어 있지 않아요.", hint: "gh auth login을 해 주세요." });
        else checks.push({ code: "gh_ok", level: "info", message: "GitHub CLI(gh) 로그인 확인" });
      }
    }
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
  if (usesAgy) checks.push(await probe("agy", s.agyCommand, s.cwd));
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
      hint:
        name === "claude"
          ? "Claude Code를 설치하고 claude 로그인을 마쳐 주세요."
          : name === "agy"
            ? "Nexus 설정 화면의 계정 칸에서 Google 계정 '로그인 창 열기'를 누르면 Antigravity CLI를 설치하고 로그인해요."
            : "OpenCode를 설치하고 opencode에서 공급자 로그인을 마쳐 주세요.",
    };
  }
  return { code: `${name}_ok`, level: "info", message: `${name} ${res.stdout.trim().split(/\r?\n/)[0] ?? ""}`.trim() };
}
