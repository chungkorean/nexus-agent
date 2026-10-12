import type { PaperclipClient } from "@nexus/paperclip-client";
import { archiveRun, notifyTelegram, type AccountState, type ArchiveInput, type Engine, type Executor, type Route, type RunOutcome, type RunRequest, type UsageEntry, type UsageSummary } from "@nexus/shared";
import type { PaperclipIssue } from "@nexus/paperclip-client";

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
  tag: UsageTag = {},
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (const route of routes) {
    const unavailable = route.accountId ? state.unavailableReason(route.accountId) : null;
    if (unavailable) {
      await log(`${routeName(route)}: ${unavailable}. 건너뛰어요.`);
      continue;
    }
    await log(`${ENGINE_LABEL[route.engine]}로 실행: ${routeName(route)}, 모델 ${route.model}`);
    await before?.(route);
    const started = Date.now();
    const outcome = await executors[route.engine].run({ ...req, model: route.model, accountDir: route.accountDir });
    attempts.push({ route, outcome });
    state.record(usageEntry(route, outcome, Date.now() - started, tag));
    if (outcome.ok || !outcome.errorFamily || !PROVIDER_ERRORS.has(outcome.errorFamily)) break;
    if (route.accountId && state.report(route.accountId, outcome.errorFamily, outcome.errorMessage)) {
      await log(`계정 ${route.accountLabel ?? route.accountId}을 잠시 쉬게 해요 (${outcome.errorFamily}).`);
    }
    await log(`${routeName(route)} 실패(${outcome.errorFamily}): ${outcome.errorMessage}. 다음 순서로 넘어가요.`);
  }
  return attempts;
}

/** 사용량 기록에 붙이는 꼬리표 */
export interface UsageTag {
  issue?: string;
  /** 작업 종류(implement 등) 또는 plan, review, conflict */
  purpose?: string;
}

export function usageEntry(route: Route, o: RunOutcome, durationMs: number, tag: UsageTag): UsageEntry {
  return {
    at: new Date().toISOString(),
    ...(tag.issue ? { issue: tag.issue } : {}),
    ...(tag.purpose ? { purpose: tag.purpose } : {}),
    alias: route.alias,
    engine: route.engine,
    model: o.model || route.model,
    ...(route.accountId ? { accountId: route.accountId } : {}),
    ok: o.ok,
    ...(o.errorFamily ? { errorFamily: o.errorFamily } : {}),
    inputTokens: o.usage?.inputTokens ?? 0,
    outputTokens: o.usage?.outputTokens ?? 0,
    cachedInputTokens: o.usage?.cachedInputTokens ?? 0,
    costUsd: o.costUsd ?? 0,
    durationMs,
  };
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

/** 결과를 보관함에 남길 때 함께 적는 것 */
export type ArchiveExtra = Omit<ArchiveInput, "issue" | "body" | "now">;

/** 결과 댓글을 남기고, 보관함에 기록하고, 텔레그램을 연결해 두었으면 같은 내용을 짧게 알린다. */
export async function postResult(client: PaperclipClient, issue: PaperclipIssue, stateDir: string, body: string, log?: Log, archive: ArchiveExtra = {}): Promise<void> {
  await safeComment(client, issue.id, body);
  try {
    const rec = await archiveRun(stateDir, { issue, body, ...archive });
    if (rec.media.length) await log?.(`만든 이미지·오디오 ${rec.media.length}개를 스튜디오에 모았어요.`);
  } catch (err) {
    await log?.(`작업 기록을 보관하지 못했어요: ${(err as Error).message}`);
  }
  await notifyTelegram(stateDir, { issueId: issue.id, identifier: issue.identifier, text: telegramSummary(issue, body) }, log);
}

const HEADING_ICON: Array<[RegExp, string]> = [
  [/완료/, "✅"],
  [/확인 필요/, "⚠️"],
  [/실패|못했어요/, "❌"],
];

/**
 * 이슈 댓글(마크다운)을 텔레그램용 짧은 글로 바꾼다. 표는 빼고, 제목 줄에는 이슈 번호와 상태 아이콘을 붙인다.
 */
export function telegramSummary(issue: Pick<PaperclipIssue, "identifier" | "id" | "title">, body: string, max = 1500): string {
  const lines = body.split(/\r?\n/);
  const first = (lines.find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  const icon = HEADING_ICON.find(([re]) => re.test(first))?.[1] ?? "ℹ️";
  const rest: string[] = [];
  let skippedFirst = false;
  for (const raw of lines) {
    if (!skippedFirst && raw.trim()) {
      skippedFirst = true;
      continue;
    }
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line)) continue;
    const plain = line.replace(/^#{1,6}\s*/, "■ ").replace(/\*\*/g, "").replace(/`/g, "");
    if (!plain.trim() && (!rest.length || !rest[rest.length - 1]!.trim())) continue;
    rest.push(plain);
  }
  let text = rest.join("\n").trim();
  if (text.length > max) text = text.slice(0, max).replace(/\n[^\n]*$/, "") + "\n…";
  return [`${icon} ${issue.identifier ?? issue.id} ${first}`, issue.title, "", text, "", "이 메시지에 답장하면 이슈에 댓글로 남기고 다시 맡겨요."]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
