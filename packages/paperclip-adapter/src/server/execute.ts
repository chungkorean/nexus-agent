import { existsSync, statSync } from "node:fs";
import { buildPrompt, classify, planRoutes, shouldPlan } from "@nexus/core";
import { ClaudeCodeExecutor } from "@nexus/executor-claude-code";
import { OpenCodeExecutor } from "@nexus/executor-opencode";
import { PaperclipClient, labelNames, type PaperclipIssue } from "@nexus/paperclip-client";
import { AccountState, loadConfig, type Classification, type Engine, type Executor, type NexusConfig } from "@nexus/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapter-types.ts";
import { ADAPTER_TYPE, bundledConfigDir, readSettings, type DispatchSettings } from "../settings.ts";
import { makePlan, runPlanned } from "./planned.ts";
import { finishIssue, firstLine, outcomeLines, routeLine, runRoutes, safeComment, sumUsage, type Attempt } from "./run.ts";

/** 테스트에서 가짜 실행기·클라이언트로 바꿔 끼울 수 있게 의존성을 모아 둔다. */
export interface DispatchDeps {
  loadConfig: (settings: DispatchSettings) => NexusConfig;
  executors: (settings: DispatchSettings) => Record<Engine, Executor>;
  client: (ctx: AdapterExecutionContext) => PaperclipClient;
  accountState: (settings: DispatchSettings) => AccountState;
}

export const defaultDeps: DispatchDeps = {
  loadConfig: (s) => loadConfig(s.configDir, bundledConfigDir(), s.accountsDir),
  executors: (s) => ({
    opencode: new OpenCodeExecutor({ command: s.opencodeCommand }),
    "claude-code": new ClaudeCodeExecutor({ command: s.claudeCommand }),
  }),
  client: (ctx) => new PaperclipClient(PaperclipClient.resolveBaseUrl(), ctx.authToken, ctx.runId),
  accountState: (s) => new AccountState(s.stateDir),
};

export async function executeDispatch(ctx: AdapterExecutionContext, deps: DispatchDeps = defaultDeps): Promise<AdapterExecutionResult> {
  const log = (line: string) => ctx.onLog("stdout", `[nexus] ${line}\n`);
  const settings = readSettings(ctx.config, ctx.context);
  const taskId = typeof ctx.context.taskId === "string" ? ctx.context.taskId : null;

  if (!taskId) {
    await log("배정된 이슈가 없어 이번 하트비트는 쉬어요.");
    return ok({ summary: "배정된 이슈 없음" });
  }

  let config: NexusConfig;
  try {
    config = deps.loadConfig(settings);
  } catch (err) {
    return failed(`설정 파일 오류: ${(err as Error).message}`, "config_invalid");
  }

  const client = deps.client(ctx);
  let issue: PaperclipIssue;
  try {
    issue = await client.getIssue(taskId);
  } catch (err) {
    return failed(`이슈 ${taskId}를 읽지 못했어요: ${(err as Error).message}`, "issue_unreadable");
  }

  // 이미 끝났거나 사람 손을 기다리는 이슈, 또는 방금 끝난 실행을 "마무리하라"고 다시 깨운 경우에는
  // 같은 작업을 처음부터 반복하지 않는다.
  await log(`이슈 ${issue.identifier ?? issue.id} 상태 ${issue.status ?? "알 수 없음"}, 깨운 이유 ${String(ctx.context.wakeReason ?? "알 수 없음")}`);
  const skip = skipReason(issue.status, ctx.context.wakeReason);
  if (skip) {
    await log(`${skip} 이번에는 실행하지 않아요.`);
    return ok({ summary: skip });
  }

  const classification = classify(
    { title: issue.title, description: issue.description, labels: labelNames(issue) },
    { defaultWhenUnsure: config.routing.defaultWhenUnsure },
  );
  await log(`분류: ${classification.decision === "execute" ? "실행 작업" : "비코딩 작업"} / ${classification.taskType} / 위험도 ${classification.risk}`);

  // 1. 비코딩 작업: Hermes 같은 비코딩 에이전트에게 하위 이슈로 넘긴다.
  if (classification.decision === "delegate" && settings.nonCodingAgentId) {
    return delegate(ctx, client, issue, classification, settings.nonCodingAgentId, log);
  }
  if (classification.decision === "delegate") {
    await log("비코딩 작업이지만 넘길 에이전트(nonCodingAgentId)가 설정되지 않아 직접 실행해요.");
  }

  // 2. 실행 작업: 작업 폴더를 확인하고 엔진·모델을 골라 실행한다.
  if (!settings.cwd || !existsSync(settings.cwd) || !statSync(settings.cwd).isDirectory()) {
    const message = settings.cwd ? `작업 폴더가 없어요: ${settings.cwd}` : "에이전트 설정에 작업 폴더(cwd)가 없어요.";
    await safeComment(client, issue.id, `Nexus가 작업을 시작하지 못했어요. ${message}`);
    return failed(message, "cwd_missing");
  }

  const cwd = settings.cwd;
  const executors = deps.executors(settings);
  const state = deps.accountState(settings);
  const labels = labelNames(issue);

  // 3. 큰 이슈는 하위 작업으로 나눠 여러 AI에게 동시에 맡긴다.
  const planDecision = shouldPlan({ title: issue.title, description: issue.description, labels }, config.routing.planning);
  let planAttempts: Attempt[] = [];
  if (planDecision.plan) {
    await log(`작업 나누기: ${planDecision.reason}`);
    const env = { ctx, client, issue, classification, config, settings: { ...settings, cwd }, executors, state, log };
    const planned = await makePlan(env);
    if (planned.plan) return runPlanned(env, planned.plan, planned.attempts);
    planAttempts = planned.attempts;
    await log(`나누지 않고 한 번에 실행해요 (${planned.reason}).`);
  }

  // 4. 한 번에 실행
  const routes = planRoutes(classification, config, { isCoolingDown: (id) => state.isCoolingDown(id) });
  if (!routes.length) {
    const message = `${classification.taskType} 작업에 쓸 모델이 설정에 없거나, 계정이 모두 한도로 쉬는 중이에요.`;
    await safeComment(client, issue.id, `Nexus가 작업을 시작하지 못했어요. ${message}`);
    return failed(message, "no_route");
  }

  const prompt = buildPrompt({ identifier: issue.identifier, title: issue.title, description: issue.description, classification, cwd });
  const attempts = await runRoutes(
    routes,
    { cwd, prompt, timeoutSec: settings.timeoutSec, onLog: ctx.onLog, signal: ctx.signal },
    executors,
    state,
    log,
    async (route) => {
      await ctx.onMeta?.({
        adapterType: ADAPTER_TYPE,
        command: route.engine === "opencode" ? "opencode serve" : "claude -p",
        cwd,
        commandNotes: [`alias=${route.alias}`, `model=${route.model}`, ...(route.accountId ? [`account=${route.accountId}`] : []), ...classification.reasons],
        prompt,
      });
    },
  );
  if (!attempts.length) {
    const message = "쓸 수 있는 계정이 모두 한도로 쉬는 중이에요.";
    await safeComment(client, issue.id, `Nexus가 작업을 시작하지 못했어요. ${message}`);
    return failed(message, "no_route");
  }

  const last = attempts[attempts.length - 1]!;
  await safeComment(client, issue.id, reportComment(classification, attempts));
  await finishIssue(client, issue.id, last.outcome.ok, { markDoneOnSuccess: settings.markDoneOnSuccess, signal: ctx.signal }, log);

  const all = [...planAttempts, ...attempts];
  const totalCost = all.reduce((sum, a) => sum + (a.outcome.costUsd ?? 0), 0);
  const result: AdapterExecutionResult = {
    exitCode: last.outcome.ok ? 0 : 1,
    signal: null,
    timedOut: last.outcome.timedOut ?? false,
    usage: planAttempts.length ? sumUsage(all.map((a) => a.outcome)) : last.outcome.usage,
    usageBasis: "per_run",
    sessionId: last.outcome.sessionId ?? null,
    provider: last.outcome.provider ?? null,
    model: last.outcome.model,
    billingType: last.route.engine === "claude-code" ? "subscription" : "unknown",
    costUsd: totalCost || null,
    summary: last.outcome.ok ? firstLine(last.outcome.summary) : `실패: ${last.outcome.errorMessage}`,
    errorMessage: last.outcome.ok ? null : last.outcome.errorMessage ?? null,
    errorFamily: last.outcome.errorFamily === "provider_quota" ? "provider_quota" : null,
    resultJson: {
      classification,
      attempts: attempts.map((a) => ({ alias: a.route.alias, account: a.route.accountId ?? null, engine: a.route.engine, model: a.route.model, ok: a.outcome.ok, error: a.outcome.errorMessage ?? null })),
      changedFiles: last.outcome.changedFiles,
    },
  };
  return result;
}

async function delegate(
  ctx: AdapterExecutionContext,
  client: PaperclipClient,
  issue: PaperclipIssue,
  c: Classification,
  agentId: string,
  log: (line: string) => Promise<void>,
): Promise<AdapterExecutionResult> {
  const companyId = issue.companyId ?? ctx.agent.companyId;
  try {
    const child = await client.createIssue(companyId, {
      title: issue.title,
      description: `${issue.description ?? ""}\n\n---\n상위 이슈 ${issue.identifier ?? issue.id}에서 Nexus가 비코딩 작업으로 판단해 넘긴 작업입니다.`.trim(),
      parentId: issue.id,
      projectId: issue.projectId ?? undefined,
      assigneeAgentId: agentId,
      status: "todo",
    });
    await safeComment(
      client,
      issue.id,
      [`Nexus가 이 이슈를 비코딩 작업으로 판단해 하위 이슈 ${child.identifier ?? child.id}로 넘겼어요.`, "", `판단 근거: ${c.reasons.join("; ")}`, "", "실행 작업이 맞다면 `code` 라벨을 붙여 다시 배정해 주세요."].join("\n"),
    );
    await log(`비코딩 에이전트(${agentId})에게 하위 이슈 ${child.identifier ?? child.id}로 넘겼어요.`);
    return ok({ summary: `비코딩 작업으로 위임: ${child.identifier ?? child.id}`, resultJson: { classification: c, delegatedIssueId: child.id } });
  } catch (err) {
    return failed(`하위 이슈를 만들지 못했어요: ${(err as Error).message}`, "delegate_failed");
  }
}

export function reportComment(c: Classification, attempts: Attempt[]): string {
  const o = attempts[attempts.length - 1]!.outcome;
  return [
    o.ok ? `### Nexus 실행 결과: 완료` : `### Nexus 실행 결과: 실패`,
    "",
    `- 실행: ${routeLine(attempts[attempts.length - 1]!.route)}`,
    `- 분류: ${c.taskType}, 위험도 ${c.risk === "high" ? "높음" : "낮음"} (${c.reasons.join("; ")})`,
    ...outcomeLines(attempts),
  ].join("\n");
}

const CLOSED_STATUSES: Record<string, string> = { done: "완료", cancelled: "취소", blocked: "막힘", in_review: "검토 중" };
/**
 * Paperclip이 작업 지시가 아니라 뒷정리를 위해 깨우는 경우. Nexus는 하위 이슈까지 한 실행 안에서 끝내므로
 * 여기서 다시 실행하면 같은 작업을 처음부터 반복하게 된다.
 * - finish_successful_run_handoff: 성공했는데 이슈가 열려 있어 마무리하라는 알림
 * - issue_children_completed: Nexus가 만든 하위 이슈가 모두 끝났다는 알림
 * - run_liveness_continuation, issue_review_path_lost: 끝난 실행을 이어 가라는 복구 알림
 */
const REPEAT_WAKES = new Set(["finish_successful_run_handoff", "issue_children_completed", "run_liveness_continuation", "issue_review_path_lost"]);

export function skipReason(status: string | null | undefined, wakeReason: unknown): string | null {
  if (status && CLOSED_STATUSES[status]) return `이슈가 이미 '${CLOSED_STATUSES[status]}' 상태예요.`;
  if (typeof wakeReason === "string" && REPEAT_WAKES.has(wakeReason)) return `작업 지시가 아니라 뒷정리 알림(${wakeReason})이에요.`;
  return null;
}

function ok(extra: Partial<AdapterExecutionResult>): AdapterExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, ...extra };
}

function failed(message: string, code: string): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, errorCode: code, summary: message };
}
