import {
  diffSnapshots,
  gitSnapshot,
  runProcess,
  type CommandSpec,
  type ErrorFamily,
  type Executor,
  type RunOutcome,
  type RunRequest,
} from "@nexus/shared";

export interface ClaudeCodeExecutorOptions {
  /** 기본값 "claude". Windows에서는 claude.cmd도 cross-spawn이 찾아 준다. */
  command?: CommandSpec;
  /**
   * 구독 계정으로 실행할 때 true(기본). 부모 환경의 ANTHROPIC_API_KEY를 지워
   * Claude Code가 API 키 과금이 아니라 로그인된 구독 계정을 쓰게 한다.
   */
  subscription?: boolean;
}

/**
 * Claude 구독 계정용 실행기. Anthropic이 구독 계정을 제3자 도구에서 쓰는 것을 금지하므로
 * Claude 모델은 OpenCode가 아니라 Claude Code(claude -p)로 실행한다.
 * 계정 분리는 계정마다 다른 CLAUDE_CONFIG_DIR로 한다.
 */
export class ClaudeCodeExecutor implements Executor {
  readonly engine = "claude-code" as const;
  constructor(private readonly opts: ClaudeCodeExecutorOptions = {}) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const before = await gitSnapshot(req.cwd);
    const res = await runProcess(
      this.opts.command ?? "claude",
      ["-p", "--output-format", "json", "--model", req.model, "--dangerously-skip-permissions"],
      {
        cwd: req.cwd,
        env: { ...req.env, ...(req.accountDir ? { CLAUDE_CONFIG_DIR: req.accountDir } : {}) },
        unsetEnv: this.opts.subscription === false ? [] : ["ANTHROPIC_API_KEY"],
        // 긴 지시문과 Windows 인수 따옴표 문제를 피하려고 지시문은 표준 입력으로 넘긴다.
        stdin: req.prompt,
        timeoutSec: req.timeoutSec,
        signal: req.signal,
        onLog: req.onLog,
      },
    );
    const changedFiles = diffSnapshots(before, await gitSnapshot(req.cwd));
    const base = { engine: "claude-code" as const, model: req.model, provider: "anthropic", changedFiles };

    if (res.spawnError) {
      return { ...base, ok: false, summary: "", errorMessage: `claude를 실행하지 못했어요: ${res.spawnError.message}`, errorFamily: "spawn_failed" };
    }
    if (res.timedOut || res.aborted) {
      return { ...base, ok: false, summary: "", timedOut: res.timedOut, errorMessage: res.timedOut ? "시간 초과로 중단했어요" : "취소됐어요", errorFamily: "timeout" };
    }

    const parsed = parseResult(res.stdout);
    if (!parsed) {
      const text = `${res.stderr}\n${res.stdout}`.trim();
      return { ...base, ok: false, summary: "", errorMessage: `Claude Code 출력을 해석하지 못했어요 (코드 ${res.exitCode}): ${text.slice(-500)}`, errorFamily: classifyError(text) };
    }

    const usage = parsed.usage
      ? {
          inputTokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.cache_creation_input_tokens ?? 0),
          outputTokens: parsed.usage.output_tokens ?? 0,
          cachedInputTokens: parsed.usage.cache_read_input_tokens ?? 0,
        }
      : undefined;
    const common = { ...base, usage, costUsd: parsed.total_cost_usd ?? null, sessionId: parsed.session_id ?? null };

    if (parsed.is_error || parsed.subtype !== "success" || res.exitCode !== 0) {
      const message = String(parsed.result ?? parsed.subtype ?? `종료 코드 ${res.exitCode}`);
      return { ...common, ok: false, summary: "", errorMessage: message, errorFamily: classifyError(message) };
    }
    return { ...common, ok: true, summary: String(parsed.result ?? "").trim() || "(응답 없음)" };
  }
}

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export function parseResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const obj = JSON.parse(c) as ClaudeResult;
      if (obj && typeof obj === "object" && ("result" in obj || "subtype" in obj)) return obj;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

export function classifyError(message: string): ErrorFamily {
  if (/usage limit|limit reached|rate.?limit|429|overloaded|quota/i.test(message)) return "provider_quota";
  if (/\/login|not logged in|invalid api key|authentication|unauthorized|401|oauth/i.test(message)) return "provider_auth";
  if (/ECONNREFUSED|ENOTFOUND|network|503|502/i.test(message)) return "provider_unavailable";
  return "task_failed";
}
