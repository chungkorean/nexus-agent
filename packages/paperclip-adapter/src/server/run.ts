import type { PaperclipClient } from "@nexus/paperclip-client";
import type { AccountState, Engine, Executor, Route, RunOutcome, RunRequest, UsageSummary } from "@nexus/shared";

export const ENGINE_LABEL: Record<Engine, string> = { opencode: "OpenCode", "claude-code": "Claude Code" };
export const PROVIDER_ERRORS = new Set(["provider_quota", "provider_auth", "provider_unavailable", "spawn_failed"]);

export interface Attempt {
  route: Route;
  outcome: RunOutcome;
}

export type Log = (line: string) => Promise<void>;

/**
 * 대체 순서대로 실행한다. 공급자 문제면 그 계정을 쉬게 하고 다음 순서로 넘어가고,
 * 작업 자체가 실패하면 다른 모델로 반복하지 않는다.
 * 다른 하위 작업이 그사이 쉬게 만든 계정은 건너뛴다.
 */
export async function runRoutes(
  routes: Route[],
  req: Omit<RunRequest, "model" | "accountDir">,
  executors: Record<Engine, Executor>,
  state: AccountState,
  log: Log,
  before?: (route: Route) => Promise<void>,
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (const route of routes) {
    if (route.accountId && state.isCoolingDown(route.accountId)) {
      await log(`${routeName(route)}: 계정이 쉬는 중이라 건너뛰어요.`);
      continue;
    }
    await log(`${ENGINE_LABEL[route.engine]}로 실행: ${routeName(route)}, 모델 ${route.model}`);
    await before?.(route);
    const outcome = await executors[route.engine].run({ ...req, model: route.model, accountDir: route.accountDir });
    attempts.push({ route, outcome });
    if (outcome.ok || !outcome.errorFamily || !PROVIDER_ERRORS.has(outcome.errorFamily)) break;
    if (route.accountId && state.report(route.accountId, outcome.errorFamily, outcome.errorMessage)) {
      await log(`계정 ${route.accountLabel ?? route.accountId}을 잠시 쉬게 해요 (${outcome.errorFamily}).`);
    }
    await log(`${routeName(route)} 실패(${outcome.errorFamily}): ${outcome.errorMessage}. 다음 순서로 넘어가요.`);
  }
  return attempts;
}

export function routeName(r: Route): string {
  return r.accountId ? `별칭 ${r.alias} · 계정 ${r.accountLabel ?? r.accountId}` : `별칭 ${r.alias}`;
}

/** 댓글에 쓰는 "어떤 엔진·모델·계정으로 돌았는지" 한 줄 */
export function routeLine(r: Route): string {
  const account = r.accountId ? `, 계정 ${r.accountLabel ?? r.accountId}` : "";
  return `${ENGINE_LABEL[r.engine]} · ${r.model} (별칭 \`${r.alias}\`${account})`;
}

/** 실행 결과 본문: 대체 실행, 토큰, 요약 또는 오류, 바뀐 파일 */
export function outcomeLines(attempts: Attempt[]): string[] {
  const last = attempts[attempts.length - 1]!;
  const o = last.outcome;
  const lines: string[] = [];
  if (attempts.length > 1) {
    const prior = attempts.slice(0, -1).map((a) => `${a.route.alias}(${a.outcome.errorFamily})`).join(", ");
    lines.push(`- 대체 실행: ${prior} 실패 후 ${last.route.alias}로 넘어감`);
  }
  if (o.usage) lines.push(`- 토큰: 입력 ${o.usage.inputTokens}, 출력 ${o.usage.outputTokens}${o.costUsd ? `, 비용 $${o.costUsd.toFixed(4)}` : ""}`);
  lines.push("");
  lines.push(o.ok ? o.summary : `오류: ${o.errorMessage}`);
  if (o.changedFiles.length) {
    lines.push("", "| 바뀐 파일 | 추가 | 삭제 |", "| --- | --- | --- |");
    for (const f of o.changedFiles.slice(0, 50)) lines.push(`| ${f.file} | ${f.additions ?? statusLabel(f.status)} | ${f.deletions ?? ""} |`);
    if (o.changedFiles.length > 50) lines.push(`| 외 ${o.changedFiles.length - 50}개 | | |`);
  }
  return lines;
}

/** git status 기호를 사람이 읽는 말로 */
export function statusLabel(status: string | undefined): string {
  if (!status) return "";
  if (status === "??" || status.includes("A")) return "새 파일";
  if (status.includes("D")) return "삭제";
  if (status.includes("R")) return "이름 바뀜";
  if (status.includes("M")) return "수정";
  return status;
}

export function sumUsage(outcomes: RunOutcome[]): UsageSummary | undefined {
  const withUsage = outcomes.filter((o) => o.usage);
  if (!withUsage.length) return undefined;
  return withUsage.reduce<UsageSummary>(
    (acc, o) => ({
      inputTokens: acc.inputTokens + o.usage!.inputTokens,
      outputTokens: acc.outputTokens + o.usage!.outputTokens,
      cachedInputTokens: (acc.cachedInputTokens ?? 0) + (o.usage!.cachedInputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );
}

export async function safeComment(client: PaperclipClient, issueId: string | null | undefined, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await client.addComment(issueId, body);
  } catch {
    /* 댓글 실패가 실행 결과를 덮지 않게 한다. 실행 로그에는 남아 있다. */
  }
}

export async function safeStatus(client: PaperclipClient, issueId: string | null | undefined, status: string, log: Log): Promise<void> {
  if (!issueId) return;
  await client.updateIssue(issueId, { status }).catch((err) => log(`이슈 상태(${status}) 변경 실패: ${(err as Error).message}`));
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? "";
}

/**
 * 실행이 끝나면 상위 이슈를 닫는다. 진행 중으로 남겨 두면 Paperclip이
 * "마무리하라"는 하트비트를 다시 보내 같은 작업을 처음부터 반복하게 된다.
 * 실행이 취소됐으면 누군가 이미 이슈 상태를 바꾼 것이니 건드리지 않는다.
 */
export async function finishIssue(
  client: PaperclipClient,
  issueId: string,
  ok: boolean,
  opts: { markDoneOnSuccess: boolean; signal?: AbortSignal },
  log: Log,
): Promise<void> {
  if (opts.signal?.aborted) return;
  if (ok && !opts.markDoneOnSuccess) return;
  await safeStatus(client, issueId, ok ? "done" : "blocked", log);
}
