import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultAgyCommand,
  diffSnapshots,
  gitSnapshot,
  runProcess,
  type CommandSpec,
  type ErrorFamily,
  type Executor,
  type RunOutcome,
  type RunRequest,
} from "@nexus/shared";

export interface AntigravityExecutorOptions {
  /** 기본값 "agy" (Antigravity CLI). Windows에서 PATH에 없으면 %LOCALAPPDATA%\agy\bin\agy.exe. */
  command?: CommandSpec;
}

/** 이보다 긴 지시문은 Windows 명령줄 길이 한도를 넘지 않게 파일로 넘긴다. */
export const MAX_ARG_PROMPT = 20_000;

/**
 * Google 계정(Gemini 구독)용 실행기. Gemini CLI가 2026년 6월부터 개인 계정을 받지 않아서
 * 그 뒤를 이은 Antigravity CLI(agy -p)로 실행한다.
 * agy는 로그인 정보를 운영체제 자격 증명 저장소에 두므로 PC 사용자당 Google 계정 하나만 쓸 수 있다.
 */
export class AntigravityExecutor implements Executor {
  readonly engine = "antigravity" as const;
  constructor(private readonly opts: AntigravityExecutorOptions = {}) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const before = await gitSnapshot(req.cwd);
    const prompt = promptArg(req.prompt);
    let res;
    try {
      res = await runProcess(this.opts.command ?? defaultAgyCommand(), agyArgs({ ...req, prompt: prompt.text }), {
        cwd: req.cwd,
        env: req.env,
        timeoutSec: req.timeoutSec,
        signal: req.signal,
        onLog: req.onLog,
      });
    } finally {
      prompt.cleanup();
    }
    const changedFiles = diffSnapshots(before, await gitSnapshot(req.cwd));
    const base = { engine: "antigravity" as const, model: req.model, provider: "antigravity", changedFiles };

    if (res.spawnError) {
      return { ...base, ok: false, summary: "", errorMessage: `agy를 실행하지 못했어요. Antigravity CLI를 설치해 주세요: ${res.spawnError.message}`, errorFamily: "spawn_failed" };
    }
    if (res.timedOut || res.aborted) {
      return { ...base, ok: false, summary: "", timedOut: res.timedOut, errorMessage: res.timedOut ? "시간 초과로 중단했어요" : "취소됐어요", errorFamily: "timeout" };
    }

    const parsed = parseResult(res.stdout);
    if (!parsed) {
      const text = `${res.stderr}\n${res.stdout}`.trim();
      return { ...base, ok: false, summary: "", errorMessage: `Antigravity CLI 출력을 해석하지 못했어요 (코드 ${res.exitCode}): ${text.slice(-500)}`, errorFamily: classifyError(text) };
    }

    const usage = parsed.usage
      ? {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: (parsed.usage.output_tokens ?? 0) + (parsed.usage.thinking_tokens ?? 0),
          cachedInputTokens: parsed.usage.cache_read_tokens ?? 0,
        }
      : undefined;
    // 구독 사용분이라 비용은 0으로 본다.
    const common = { ...base, usage, costUsd: 0, sessionId: parsed.conversation_id ?? null };

    if (parsed.status !== "SUCCESS" || res.exitCode !== 0) {
      const message = errorText(parsed) || `종료 코드 ${res.exitCode}`;
      return { ...common, ok: false, summary: "", errorMessage: message, errorFamily: parsed.status === "CANCELED" ? "timeout" : classifyError(message) };
    }
    return { ...common, ok: true, summary: String(parsed.response ?? "").trim() || "(응답 없음)" };
  }
}

/** 읽기 전용이면 도구 승인을 하지 않는다(agy는 승인 안 된 도구를 거절하고 계속한다). */
export function agyArgs(req: Pick<RunRequest, "model" | "readOnly" | "prompt">): string[] {
  const args = ["-p", req.prompt, "--output-format", "json", "--model", req.model];
  return req.readOnly ? args : [...args, "--dangerously-skip-permissions"];
}

/** 긴 지시문은 작업 폴더 밖 임시 파일에 두고, 그 파일을 읽으라고 짧게 지시한다. */
export function promptArg(prompt: string, limit = MAX_ARG_PROMPT): { text: string; cleanup: () => void } {
  if (prompt.length <= limit) return { text: prompt, cleanup: () => {} };
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-agy-"));
  const file = path.join(dir, "task.md");
  writeFileSync(file, prompt, "utf8");
  return {
    text: `이번 작업 지시문은 길어서 파일에 넣어 두었어요. 먼저 이 파일을 끝까지 읽고, 그 지시대로 작업해 주세요: ${file}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface AgyResult {
  response?: string;
  status?: "SUCCESS" | "ERROR" | "CANCELED" | string;
  error?: string | { message?: string } | null;
  conversation_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number; total_tokens?: number };
}

function errorText(r: AgyResult): string {
  if (!r.error) return r.status && r.status !== "SUCCESS" ? r.status : "";
  return typeof r.error === "string" ? r.error : (r.error.message ?? JSON.stringify(r.error));
}

export function parseResult(stdout: string): AgyResult | null {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const obj = JSON.parse(c) as AgyResult;
      if (obj && typeof obj === "object" && ("status" in obj || "response" in obj)) return obj;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

export function classifyError(message: string): ErrorFamily {
  if (/quota|limit|exhausted|rate.?limit|429|resource_exhausted/i.test(message)) return "provider_quota";
  if (/sign.?in|log.?in|not authenticated|unauthenticated|credential|unauthorized|401|oauth/i.test(message)) return "provider_auth";
  if (/ECONNREFUSED|ENOTFOUND|network|unavailable|503|502/i.test(message)) return "provider_unavailable";
  return "task_failed";
}
