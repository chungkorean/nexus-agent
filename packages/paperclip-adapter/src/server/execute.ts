import { existsSync, statSync } from "node:fs";
import { buildPrompt, classify, planRoutes } from "@nexus/core";
import { ClaudeCodeExecutor } from "@nexus/executor-claude-code";
import { OpenCodeExecutor } from "@nexus/executor-opencode";
import { PaperclipClient, labelNames, type PaperclipIssue } from "@nexus/paperclip-client";
import { loadConfig, type Classification, type Engine, type Executor, type NexusConfig, type Route, type RunOutcome } from "@nexus/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapter-types.ts";
import { ADAPTER_TYPE, bundledConfigDir, readSettings, type DispatchSettings } from "../settings.ts";

/** 테스트에서 가짜 실행기·클라이언트로 바꿔 끼울 수 있게 의존성을 모아 둔다. */
export interface DispatchDeps {
  loadConfig: (settings: DispatchSettings) => NexusConfig;
  executors: (settings: DispatchSettings) => Record<Engine, Executor>;
  client: (ctx: AdapterExecutionContext) => PaperclipClient;
}

export const defaultDeps: DispatchDeps = {
  loadConfig: (s) => loadConfig(s.configDir, bundledConfigDir()),
  executors: (s) => ({
    opencode: new OpenCodeExecutor({ command: s.opencodeCommand }),
    "claude-code": new ClaudeCodeExecutor({ command: s.claudeCommand }),
  }),
  client: (ctx) => new PaperclipClient(PaperclipClient.resolveBaseUrl(), ctx.authToken, ctx.runId),
};

const ENGINE_LABEL: Record<Engine, string> = { opencode: "OpenCode", "claude-code": "Claude Code" };
const PROVIDER_ERRORS = new Set(["provider_quota", "provider_auth", "provider_unavailable", "spawn_failed"]);

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

  const routes = planRoutes(classification, config);
  if (!routes.length) return failed(`${classification.taskType} 작업에 쓸 모델이 설정에 없어요.`, "no_route");

  const prompt = buildPrompt({ identifier: issue.identifier, title: issue.title, description: issue.description, classification, cwd: settings.cwd });
  const executors = deps.executors(settings);
  const attempts: Array<{ route: Route; outcome: RunOutcome }> = [];

  for (const route of routes) {
    await log(`${ENGINE_LABEL[route.engine]}로 실행: 별칭 ${route.alias}, 모델 ${route.model}`);
    await ctx.onMeta?.({
      adapterType: ADAPTER_TYPE,
      command: route.engine === "opencode" ? "opencode serve" : "claude -p",
      cwd: settings.cwd,
      commandNotes: [`alias=${route.alias}`, `model=${route.model}`, ...classification.reasons],
      prompt,
    });
    const outcome = await executors[route.engine].run({
      cwd: settings.cwd,
      prompt,
      model: route.model,
      accountDir: route.accountDir,
      timeoutSec: settings.timeoutSec,
      onLog: ctx.onLog,
      signal: ctx.signal,
    });
    attempts.push({ route, outcome });
    // 공급자 쪽 문제일 때만 다음 별칭으로 넘어간다. 작업 자체가 실패했으면 다른 모델로 반복하지 않는다.
    if (outcome.ok || !outcome.errorFamily || !PROVIDER_ERRORS.has(outcome.errorFamily)) break;
    await log(`${route.alias} 실패(${outcome.errorFamily}): ${outcome.errorMessage}. 다음 순서로 넘어가요.`);
  }

  const last = attempts[attempts.length - 1]!;
  await safeComment(client, issue.id, reportComment(classification, attempts));
  if (last.outcome.ok && settings.markDoneOnSuccess) {
    await client.updateIssue(issue.id, { status: "done" }).catch((err) => log(`상태 변경 실패: ${(err as Error).message}`));
  }

  const totalCost = attempts.reduce((sum, a) => sum + (a.outcome.costUsd ?? 0), 0);
  const result: AdapterExecutionResult = {
    exitCode: last.outcome.ok ? 0 : 1,
    signal: null,
    timedOut: last.outcome.timedOut ?? false,
    usage: last.outcome.usage,
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
      attempts: attempts.map((a) => ({ alias: a.route.alias, engine: a.route.engine, model: a.route.model, ok: a.outcome.ok, error: a.outcome.errorMessage ?? null })),
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

export function reportComment(c: Classification, attempts: Array<{ route: Route; outcome: RunOutcome }>): string {
  const last = attempts[attempts.length - 1]!;
  const o = last.outcome;
  const lines: string[] = [];
  lines.push(o.ok ? `### Nexus 실행 결과: 완료` : `### Nexus 실행 결과: 실패`);
  lines.push("");
  lines.push(`- 실행: ${ENGINE_LABEL[last.route.engine]} · ${last.route.model} (별칭 \`${last.route.alias}\`)`);
  lines.push(`- 분류: ${c.taskType}, 위험도 ${c.risk === "high" ? "높음" : "낮음"} (${c.reasons.join("; ")})`);
  if (attempts.length > 1) {
    const prior = attempts.slice(0, -1).map((a) => `${a.route.alias}(${a.outcome.errorFamily})`).join(", ");
    lines.push(`- 대체 실행: ${prior} 실패 후 ${last.route.alias}로 넘어감`);
  }
  if (o.usage) lines.push(`- 토큰: 입력 ${o.usage.inputTokens}, 출력 ${o.usage.outputTokens}${o.costUsd ? `, 비용 $${o.costUsd.toFixed(4)}` : ""}`);
  lines.push("");
  if (o.ok) {
    lines.push(o.summary);
  } else {
    lines.push(`오류: ${o.errorMessage}`);
  }
  if (o.changedFiles.length) {
    lines.push("", "| 바뀐 파일 | 추가 | 삭제 |", "| --- | --- | --- |");
    for (const f of o.changedFiles.slice(0, 50)) lines.push(`| ${f.file} | ${f.additions ?? f.status ?? ""} | ${f.deletions ?? ""} |`);
    if (o.changedFiles.length > 50) lines.push(`| 외 ${o.changedFiles.length - 50}개 | | |`);
  }
  return lines.join("\n");
}

async function safeComment(client: PaperclipClient, issueId: string, body: string): Promise<void> {
  try {
    await client.addComment(issueId, body);
  } catch {
    /* 댓글 실패가 실행 결과를 덮지 않게 한다. 실행 로그에는 남아 있다. */
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? "";
}

function ok(extra: Partial<AdapterExecutionResult>): AdapterExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, ...extra };
}

function failed(message: string, code: string): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, errorCode: code, summary: message };
}
