import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildPlanPrompt, buildSubtaskPrompt, expandAliases, parsePlan, planRoutes, PlanError, runSchedule } from "@nexus/core";
import type { PaperclipClient, PaperclipIssue } from "@nexus/paperclip-client";
import {
  addWorktree,
  commitAll,
  mergeInto,
  mergeIntoWorkdir,
  repoInfo,
  safeRef,
  uniqueBranch,
  type AccountState,
  type Classification,
  type Engine,
  type Executor,
  type NexusConfig,
  type Plan,
  type RunOutcome,
  type Subtask,
  type WorkdirMergeResult,
  type Worktree,
} from "@nexus/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapter-types.ts";
import { ADAPTER_TYPE, type DispatchSettings } from "../settings.ts";
import { aggregate, checkLines, type AggregateResult } from "./aggregate.ts";
import { githubLines, publishToGithub, type GithubResult } from "./github.ts";
import { cleanupWorktree, serialGit } from "./gitqueue.ts";
import { finishIssue, firstLine, outcomeLines, routeLine, runRoutes, safeComment, safeStatus, sumUsage, type Attempt, type Log } from "./run.ts";

export interface PlannedEnv {
  ctx: AdapterExecutionContext;
  client: PaperclipClient;
  issue: PaperclipIssue;
  classification: Classification;
  config: NexusConfig;
  settings: DispatchSettings & { cwd: string };
  executors: Record<Engine, Executor>;
  state: AccountState;
  log: Log;
}

/** 계획 세우기. 읽기 전용으로 실행해 하위 작업 목록을 받는다. 못 받으면 null (한 번에 실행으로 돌아감) */
export async function makePlan(env: PlannedEnv): Promise<{ plan: Plan | null; attempts: Attempt[]; reason?: string }> {
  const { config, settings, issue } = env;
  const policy = config.routing.planning;
  const chain = [...new Set([policy.planner, ...config.routing.taskTypes.design])].slice(0, config.routing.maxFallbacks + 1);
  const routes = expandAliases(chain, config, { isCoolingDown: (id) => env.state.isCoolingDown(id) });
  if (!routes.length) return { plan: null, attempts: [], reason: "계획을 세울 모델·계정이 모두 쉬는 중" };

  const prompt = buildPlanPrompt({ identifier: issue.identifier, title: issue.title, description: issue.description, cwd: settings.cwd, maxSubtasks: policy.maxSubtasks });
  await env.log("작업을 하위 작업으로 나누는 중이에요.");
  const attempts = await runRoutes(
    routes,
    { cwd: settings.cwd, prompt, readOnly: true, timeoutSec: Math.min(settings.timeoutSec, 600), onLog: env.ctx.onLog, signal: env.ctx.signal },
    env.executors,
    env.state,
    env.log,
  );
  const last = attempts[attempts.length - 1];
  if (!last?.outcome.ok) return { plan: null, attempts, reason: `계획 실패: ${last?.outcome.errorMessage ?? "실행할 모델 없음"}` };
  try {
    const plan = parsePlan(last.outcome.summary, policy.maxSubtasks);
    if (plan.subtasks.length < 2) return { plan: null, attempts, reason: "나눌 필요가 없다는 계획" };
    return { plan, attempts };
  } catch (err) {
    return { plan: null, attempts, reason: err instanceof PlanError ? err.message : String(err) };
  }
}

interface SubtaskRun {
  ok: boolean;
  attempts: Attempt[];
  branch?: string;
  commit?: string | null;
  childId?: string | null;
  childIdentifier?: string | null;
  error?: string;
}

/**
 * 하위 작업을 Paperclip 하위 이슈로 보여 주고, 각자 worktree에서 동시에 실행한다.
 * 결과는 하위 작업마다 nexus/<이슈>/<키> 브랜치에 커밋으로 남고, 모두 성공하면 작업 폴더에 합친다(autoMerge).
 */
export async function runPlanned(env: PlannedEnv, plan: Plan, planAttempts: Attempt[]): Promise<AdapterExecutionResult> {
  const { ctx, client, issue, classification, config, settings, log } = env;
  const ident = issue.identifier ?? issue.id;
  const repo = await repoInfo(settings.cwd);
  const concurrency = repo ? config.routing.planning.concurrency : 1;
  const runTag = randomBytes(3).toString("hex");
  const notes: string[] = [];
  if (!repo) notes.push("작업 폴더가 커밋이 있는 git 저장소가 아니어서 하위 작업을 한 번에 하나씩 같은 폴더에서 실행했어요.");
  else if (repo.dirty) notes.push("작업 폴더에 커밋하지 않은 변경이 있어요. 하위 작업은 마지막 커밋에서 시작하므로 그 변경은 포함되지 않았어요.");
  const subdir = repo ? path.relative(repo.root, path.resolve(settings.cwd)) : "";

  // 1. 하위 이슈 만들기. 담당자를 비워 두어 다른 에이전트가 깨어나지 않게 한다.
  const runs = new Map<string, SubtaskRun>();
  for (const s of plan.subtasks) {
    const run: SubtaskRun = { ok: false, attempts: [] };
    try {
      const child = await client.createIssue(issue.companyId ?? ctx.agent.companyId, {
        title: `[${s.key}] ${s.title}`,
        description: [
          s.instructions,
          "",
          s.files.length ? `주로 고칠 파일: ${s.files.join(", ")}` : "",
          s.dependsOn.length ? `먼저 끝나야 하는 작업: ${s.dependsOn.join(", ")}` : "",
          "",
          `---\n상위 이슈 ${ident}에서 Nexus가 나눈 하위 작업입니다. Nexus가 직접 실행하니 담당자를 지정하지 마세요.`,
        ]
          .filter((l, i, a) => l || a[i - 1])
          .join("\n")
          .trim(),
        parentId: issue.id,
        projectId: issue.projectId ?? undefined,
        status: "todo",
      });
      run.childId = child.id;
      run.childIdentifier = child.identifier ?? child.id;
    } catch (err) {
      await log(`하위 이슈를 만들지 못했어요 (${s.key}): ${(err as Error).message}`);
    }
    runs.set(s.key, run);
  }

  await safeComment(client, issue.id, planComment(plan, runs, config, classification, concurrency));
  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "nexus plan",
    cwd: settings.cwd,
    commandNotes: [`subtasks=${plan.subtasks.length}`, `concurrency=${concurrency}`, ...classification.reasons],
  });

  // 2. 의존 순서와 동시 실행 수를 지키며 실행한다.
  const results = await runSchedule(
    plan.subtasks,
    concurrency,
    async (s, index) => {
      const run = runs.get(s.key)!;
      Object.assign(run, await runSubtask(env, plan, s, index, { repo, subdir, runTag, ident, runs }));
      return run;
    },
    async (s, failedDeps) => {
      const run = runs.get(s.key)!;
      run.error = `앞 작업(${failedDeps.join(", ")})이 끝나지 않아 건너뛰었어요.`;
      await safeComment(client, run.childId, `Nexus가 이 하위 작업을 건너뛰었어요. ${run.error}`);
      await safeStatus(client, run.childId, "blocked", log);
    },
  );

  // 3. 취합: 결과 브랜치로 합치고 테스트·검토한 뒤, 조건이 맞으면 작업 폴더에 합친다.
  const allDone = plan.subtasks.every((s) => results.get(s.key)?.status === "done");
  const committed = topoOrder(plan).filter((s) => runs.get(s.key)?.commit && runs.get(s.key)?.branch).map((s) => ({ key: s.key, branch: runs.get(s.key)!.branch! }));
  let agg: AggregateResult | null = null;
  if (repo && allDone && committed.length && !ctx.signal?.aborted) {
    agg = await aggregate(env, plan, {
      repoRoot: repo.root,
      base: repo.head,
      subdir,
      ident,
      runTag,
      branches: committed,
      implementers: [...runs.values()].flatMap((r) => r.attempts.filter((a) => a.outcome.ok).map((a) => a.route)),
    });
  }
  const gate = mergeGate(agg, classification.risk, settings.autoMerge);
  let merge: WorkdirMergeResult | null = null;
  if (repo && agg?.ok && agg.branch && gate.allowed && !ctx.signal?.aborted) {
    merge = await serialGit(() => mergeIntoWorkdir(repo.root, [agg!.branch!]));
    await log(merge.ok ? `작업 폴더의 ${merge.branch} 브랜치에 결과를 합쳤어요.` : `자동으로 합치지 못했어요: ${merge.reason}`);
  }
  const overallOk = allDone && (!agg || (agg.ok && agg.tests?.status !== "failed"));
  const aggAttempts = agg?.attempts ?? [];
  let summary = summaryComment(plan, runs, results, notes, Boolean(repo), { agg, gate, merge, overallOk, attempts: [...planAttempts, ...[...runs.values()].flatMap((r) => r.attempts), ...aggAttempts] });
  let github: GithubResult | null = null;
  if (repo && agg?.ok && agg.branch && config.routing.results.githubPush && !ctx.signal?.aborted) {
    await log(`결과 브랜치를 GitHub(${config.routing.results.githubRemote})에 올려요.`);
    github = await serialGit(() =>
      publishToGithub(repo.root, agg!.branch!, {
        remote: config.routing.results.githubRemote,
        pullRequest: config.routing.results.githubPullRequest,
        title: `${ident}: ${issue.title}`,
        body: `Paperclip 이슈 ${ident}에서 Nexus가 만든 결과예요.\n\n${summary}`,
        ghCommand: settings.ghCommand,
        signal: ctx.signal,
      }),
    );
    await log(github.pushed ? `GitHub에 올렸어요${github.prUrl ? `: ${github.prUrl}` : ""}.` : `GitHub에 올리지 못했어요: ${github.error}`);
    summary += "\n" + githubLines(github, agg.branch).join("\n");
  }
  await safeComment(client, issue.id, summary);
  await finishIssue(client, issue.id, overallOk, { markDoneOnSuccess: settings.markDoneOnSuccess, signal: ctx.signal }, log);

  const outcomes: RunOutcome[] = [...planAttempts, ...[...runs.values()].flatMap((r) => r.attempts), ...aggAttempts].map((a) => a.outcome);
  const usedRoutes = [...runs.values()].flatMap((r) => r.attempts.map((a) => a.route));
  const models = [...new Set(usedRoutes.map((r) => r.model))];
  const totalCost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  const doneCount = plan.subtasks.filter((s) => results.get(s.key)?.status === "done").length;
  return {
    exitCode: overallOk ? 0 : 1,
    signal: null,
    timedOut: false,
    usage: sumUsage(outcomes),
    usageBasis: "per_run",
    model: models.join(", ") || null,
    provider: models.length === 1 ? (usedRoutes[0]?.engine === "claude-code" ? "anthropic" : models[0]!.split("/")[0]) : null,
    billingType: usedRoutes.length && usedRoutes.every((r) => r.engine === "claude-code") ? "subscription" : "unknown",
    costUsd: totalCost || null,
    summary: `하위 작업 ${plan.subtasks.length}개 중 ${doneCount}개 완료${agg?.tests ? `, 테스트 ${TEST_LABEL[agg.tests.status]}` : ""}${firstLine(plan.summary) ? `: ${firstLine(plan.summary)}` : ""}`,
    errorMessage: overallOk ? null : !allDone ? `하위 작업 ${plan.subtasks.length - doneCount}개가 끝나지 않았어요` : agg?.error ?? (agg?.tests?.status === "failed" ? "합친 결과가 테스트를 통과하지 못했어요" : null),
    resultJson: {
      classification,
      plan,
      merged: merge?.ok ? { branch: merge.branch, head: merge.head } : null,
      result: agg
        ? { github: github ? { pushed: github.pushed, prUrl: github.prUrl ?? null, error: github.error ?? github.prError ?? null } : null, ok: agg.ok, branch: agg.branch, head: agg.head, error: agg.error ?? null, tests: agg.tests, review: agg.review ? { verdict: agg.review.verdict, sameProvider: agg.review.sameProvider } : null, conflictsResolved: agg.resolutions.length }
        : null,
      subtasks: plan.subtasks.map((s) => {
        const r = runs.get(s.key)!;
        return {
          key: s.key,
          status: results.get(s.key)?.status ?? "skipped",
          issueId: r.childId ?? null,
          branch: r.branch ?? null,
          commit: r.commit ?? null,
          attempts: r.attempts.map((a) => ({ alias: a.route.alias, account: a.route.accountId ?? null, model: a.route.model, ok: a.outcome.ok, error: a.outcome.errorMessage ?? null })),
        };
      }),
    },
  };
}


async function runSubtask(
  env: PlannedEnv,
  plan: Plan,
  s: Subtask,
  index: number,
  shared: { repo: Awaited<ReturnType<typeof repoInfo>>; subdir: string; runTag: string; ident: string; runs: Map<string, SubtaskRun> },
): Promise<Partial<SubtaskRun>> {
  const { client, config, settings, log, classification } = env;
  const run = shared.runs.get(s.key)!;
  const slog: Log = (line) => log(`[${s.key}] ${line}`);
  const routes = planRoutes({ taskType: s.taskType, risk: classification.risk }, config, { isCoolingDown: (id) => env.state.isCoolingDown(id), spread: index });
  await safeStatus(client, run.childId, "in_progress", slog);

  const finish = async (result: Partial<SubtaskRun>): Promise<Partial<SubtaskRun>> => {
    const attempts = result.attempts ?? [];
    const lines = [`### Nexus 하위 작업 결과: ${result.ok ? "완료" : "실패"}`, ""];
    if (attempts.length) lines.push(`- 실행: ${routeLine(attempts[attempts.length - 1]!.route)}`);
    if (result.branch) lines.push(`- 브랜치: \`${result.branch}\`${result.commit ? ` (커밋 ${result.commit.slice(0, 8)})` : " (바뀐 파일 없음)"}`);
    if (attempts.length) lines.push(...outcomeLines(attempts));
    else if (result.error) lines.push("", `오류: ${result.error}`);
    await safeComment(client, run.childId, lines.join("\n"));
    await safeStatus(client, run.childId, result.ok ? "done" : "blocked", slog);
    return result;
  };

  if (!routes.length) return finish({ ok: false, error: `${s.taskType} 작업에 쓸 모델·계정이 없거나 모두 쉬는 중이에요.` });

  // git 저장소가 아니면 같은 폴더에서 차례로 실행한다.
  if (!shared.repo) {
    const attempts = await runSubtaskRoutes(env, plan, s, routes, settings.cwd, slog);
    return finish({ ok: Boolean(attempts.at(-1)?.outcome.ok), attempts });
  }

  const repo = shared.repo;
  let wt: Worktree | null = null;
  try {
    const dir = path.join(settings.worktreeRoot, `${safeRef(shared.ident)}-${shared.runTag}`, safeRef(s.key));
    wt = await serialGit(async () => {
      const branch = await uniqueBranch(repo.root, `nexus/${safeRef(shared.ident)}/${safeRef(s.key)}`);
      return addWorktree(repo.root, dir, branch, repo.head);
    });
    const branch = wt.branch;
    const depBranches = s.dependsOn.map((d) => shared.runs.get(d)?.branch).filter((b): b is string => Boolean(b));
    if (depBranches.length) {
      const merged = await mergeInto(wt, depBranches);
      if (!merged.ok) return finish({ ok: false, branch, error: `앞 작업 브랜치 ${merged.branch}를 합치지 못했어요. ${merged.message}` });
    }
    const attempts = await runSubtaskRoutes(env, plan, s, routes, path.join(wt.dir, shared.subdir), slog);
    const ok = Boolean(attempts.at(-1)?.outcome.ok);
    const commit = await commitAll(wt, `${shared.ident} ${s.key}: ${s.title}${ok ? "" : " (실패, 일부 변경)"}`);
    return finish({ ok, attempts, branch, commit });
  } catch (err) {
    return finish({ ok: false, error: (err as Error).message, attempts: run.attempts });
  } finally {
    if (wt) await cleanupWorktree(wt, slog);
  }
}

async function runSubtaskRoutes(env: PlannedEnv, plan: Plan, s: Subtask, routes: ReturnType<typeof planRoutes>, cwd: string, log: Log): Promise<Attempt[]> {
  const prompt = buildSubtaskPrompt({
    identifier: env.issue.identifier,
    parentTitle: env.issue.title,
    planSummary: plan.summary,
    subtask: s,
    others: plan.subtasks.filter((o) => o.key !== s.key),
    risk: env.classification.risk,
    cwd,
  });
  return runRoutes(routes, { cwd, prompt, timeoutSec: env.settings.timeoutSec, onLog: env.ctx.onLog, signal: env.ctx.signal }, env.executors, env.state, log);
}

const TASK_TYPE_KO: Record<string, string> = {
  design: "설계",
  implement: "구현",
  refactor: "리팩터",
  test: "테스트",
  review: "리뷰",
  docs: "문서",
  research: "조사",
  ops: "터미널·파일",
};

function planComment(plan: Plan, runs: Map<string, SubtaskRun>, config: NexusConfig, c: Classification, concurrency: number): string {
  const lines = [`### Nexus 작업 계획: 하위 작업 ${plan.subtasks.length}개`, ""];
  if (plan.summary) lines.push(plan.summary, "");
  lines.push("| 하위 작업 | 이슈 | 종류 | 처음 맡을 AI | 먼저 끝나야 할 작업 |", "| --- | --- | --- | --- | --- |");
  plan.subtasks.forEach((s, i) => {
    const first = planRoutes({ taskType: s.taskType, risk: c.risk }, config, { spread: i })[0];
    const ai = first ? `${config.aliases[first.alias]?.label ?? first.alias}${first.accountLabel ? ` · ${first.accountLabel}` : ""}` : "없음";
    lines.push(`| ${s.key}: ${s.title} | ${runs.get(s.key)?.childIdentifier ?? "-"} | ${TASK_TYPE_KO[s.taskType] ?? s.taskType} | ${ai} | ${s.dependsOn.join(", ") || "-"} |`);
  });
  lines.push("", `동시에 최대 ${concurrency}개씩 실행해요. 진행 상황은 각 하위 이슈에서 볼 수 있어요.`);
  return lines.join("\n");
}

export const TEST_LABEL: Record<string, string> = { passed: "통과", failed: "실패", unavailable: "도구 없음", none: "없음" };

/** 의존 순서대로 (앞 작업이 먼저) */
export function topoOrder(plan: Plan): Subtask[] {
  const done = new Set<string>();
  const out: Subtask[] = [];
  let rest = [...plan.subtasks];
  while (rest.length) {
    const ready = rest.filter((s) => s.dependsOn.every((d) => done.has(d) || !plan.subtasks.some((o) => o.key === d)));
    const next = ready.length ? ready : rest.slice(0, 1);
    for (const s of next) {
      out.push(s);
      done.add(s.key);
    }
    rest = rest.filter((s) => !done.has(s.key));
  }
  return out;
}

/** 결과 브랜치를 사용자 작업 폴더에 자동으로 합쳐도 되는지 */
export function mergeGate(agg: AggregateResult | null, risk: string, autoMerge: boolean): { allowed: boolean; reason?: string } {
  if (!agg) return { allowed: false };
  if (!agg.ok) return { allowed: false, reason: agg.error };
  if (!autoMerge) return { allowed: false, reason: "자동 합치기가 꺼져 있어요." };
  if (agg.tests?.status === "failed") return { allowed: false, reason: "합친 결과가 테스트를 통과하지 못해서 작업 폴더에 합치지 않았어요." };
  if (agg.review?.verdict === "attention") return { allowed: false, reason: "검토자가 확인이 필요하다고 해서 작업 폴더에 합치지 않았어요." };
  if (risk === "high") return { allowed: false, reason: "위험도가 높은 작업이라 사람이 확인한 뒤 합치도록 남겨 뒀어요." };
  return { allowed: true };
}

function summaryComment(
  plan: Plan,
  runs: Map<string, SubtaskRun>,
  results: Map<string, { status: string }>,
  notes: string[],
  hasRepo: boolean,
  extra: { agg: AggregateResult | null; gate: { allowed: boolean; reason?: string }; merge: WorkdirMergeResult | null; overallOk: boolean; attempts: Attempt[] },
): string {
  const { agg, gate, merge, overallOk } = extra;
  const status = (k: string) => results.get(k)?.status ?? "skipped";
  const done = plan.subtasks.filter((s) => status(s.key) === "done").length;
  const heading = overallOk ? "완료" : done === plan.subtasks.length ? "확인 필요" : "일부 실패";
  const lines = [`### Nexus 실행 결과: ${heading} (${done}/${plan.subtasks.length})`, ""];
  lines.push("| 하위 작업 | 결과 | 실행한 AI | 바뀐 파일 | 브랜치 |", "| --- | --- | --- | --- | --- |");
  for (const s of plan.subtasks) {
    const r = runs.get(s.key)!;
    const last = r.attempts.at(-1);
    const label = { done: "완료", failed: "실패", skipped: "건너뜀" }[status(s.key)] ?? status(s.key);
    const ai = last ? `${last.route.model}${last.route.accountLabel ? ` · ${last.route.accountLabel}` : ""}` : "-";
    lines.push(`| ${r.childIdentifier ?? s.key}: ${s.title} | ${label} | ${ai} | ${last?.outcome.changedFiles.length ?? 0} | ${r.branch ? `\`${r.branch}\`` : "-"} |`);
  }
  const failed = plan.subtasks.filter((s) => status(s.key) !== "done");
  if (failed.length) {
    lines.push("", "끝나지 않은 작업:");
    for (const s of failed) {
      const r = runs.get(s.key)!;
      lines.push(`- ${s.key}: ${r.error ?? r.attempts.at(-1)?.outcome.errorMessage ?? "이유 없음"}`);
    }
  }

  if (agg) {
    lines.push("", "#### 합친 결과");
    if (agg.branch && agg.ok) lines.push(`- 결과 브랜치: \`${agg.branch}\`${agg.head ? ` (커밋 ${agg.head.slice(0, 8)})` : ""}, 바뀐 파일 ${agg.files.length}개`);
    for (const r of agg.resolutions) {
      const by = r.attempts.at(-1)?.route;
      lines.push(`- 충돌 해결: \`${r.branch}\` (${r.files.join(", ")}) → ${r.ok ? "AI가 풀었어요" : "풀지 못했어요"}${by ? ` · ${by.model}` : ""}`);
    }
    if (!agg.ok && agg.error) lines.push(`- 합치기 실패: ${agg.error}`);
    lines.push(...checkLines(agg.tests, agg.review, agg.ok));
  }

  const branches = plan.subtasks.map((s) => runs.get(s.key)?.commit && runs.get(s.key)?.branch).filter(Boolean) as string[];
  if (hasRepo && merge?.ok) {
    lines.push("", `결과를 작업 폴더의 \`${merge.branch}\` 브랜치에 자동으로 합쳤어요 (커밋 ${merge.head.slice(0, 8)}). 하위 작업 브랜치와 결과 브랜치도 그대로 남아 있어요.`);
  } else if (hasRepo && agg?.ok && agg.branch) {
    const why = merge && !merge.ok ? `자동으로 합치지 못했어요. ${merge.reason}` : gate.reason;
    if (why) lines.push("", why);
    lines.push("", "작업 폴더에 합치려면:", "```", `git merge ${agg.branch}`, "```");
  } else if (hasRepo && branches.length) {
    lines.push("", "각 하위 작업의 변경은 브랜치에 커밋으로 남겼어요. 작업 폴더에 합치려면:", "```", `git merge ${branches.join(" ")}`, "```");
  }

  const usage = usageByModel(extra.attempts);
  if (usage.length > 1 || (usage.length === 1 && usage[0]!.runs > 1)) {
    lines.push("", "#### 모델별 사용량", "| 모델 | 실행 | 입력 토큰 | 출력 토큰 | 비용 |", "| --- | --- | --- | --- | --- |");
    for (const u of usage) lines.push(`| ${u.model} | ${u.runs} | ${u.input} | ${u.output} | ${u.cost ? `$${u.cost.toFixed(4)}` : "-"} |`);
  }
  if (notes.length) lines.push("", ...notes.map((n) => `참고: ${n}`));
  return lines.join("\n");
}

function usageByModel(attempts: Attempt[]): Array<{ model: string; runs: number; input: number; output: number; cost: number }> {
  const map = new Map<string, { model: string; runs: number; input: number; output: number; cost: number }>();
  for (const a of attempts) {
    const label = `${a.route.model}${a.route.accountLabel ? ` · ${a.route.accountLabel}` : ""}`;
    const u = map.get(label) ?? { model: label, runs: 0, input: 0, output: 0, cost: 0 };
    u.runs += 1;
    u.input += a.outcome.usage?.inputTokens ?? 0;
    u.output += a.outcome.usage?.outputTokens ?? 0;
    u.cost += a.outcome.costUsd ?? 0;
    map.set(label, u);
  }
  return [...map.values()].sort((x, y) => y.cost - x.cost || y.output - x.output);
}
