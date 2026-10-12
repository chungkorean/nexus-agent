import { existsSync, lstatSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { planRoutes } from "@nexus/core";
import {
  abortMerge,
  addWorktree,
  concludeMerge,
  diffBetween,
  filesWithConflictMarkers,
  headOf,
  mergeKeepConflicts,
  safeRef,
  uniqueBranch,
  type Plan,
  type Route,
  type Worktree,
} from "@nexus/shared";
import { cleanupWorktree, serialGit } from "./gitqueue.ts";
import type { PlannedEnv } from "./planned.ts";
import { engineProvider, runRoutes, type Attempt } from "./run.ts";
import { runTests, type TestRun } from "./verify.ts";

export interface Resolution {
  branch: string;
  files: string[];
  ok: boolean;
  attempts: Attempt[];
}

export interface Review {
  verdict: "ok" | "attention" | "unknown";
  text: string;
  /** 구현한 모델과 같은 회사 모델밖에 없어서 같은 회사 모델로 검토했는지 */
  sameProvider: boolean;
  attempts: Attempt[];
}

export interface AggregateResult {
  ok: boolean;
  /** 모든 하위 작업을 합친 결과 브랜치 */
  branch: string | null;
  head: string | null;
  error?: string;
  resolutions: Resolution[];
  tests: TestRun | null;
  review: Review | null;
  stat: string;
  files: string[];
  /** 충돌 해결·검토에 쓴 실행 (비용 합산용) */
  attempts: Attempt[];
}

export const MAX_REVIEW_DIFF = 60_000;

/** 엔진·모델로 공급사를 정한다. Claude Code는 Anthropic, OpenCode는 "openai/gpt-5"의 앞부분 */
export function routeProvider(r: Pick<Route, "engine" | "model">): string {
  return engineProvider(r.engine, r.model);
}

/**
 * 취합기: 하위 작업 브랜치를 차례로 결과 브랜치에 합치고(충돌은 AI가 한 번 풂),
 * 합친 결과로 테스트를 돌리고, 구현과 다른 회사 모델이 전체 변경을 검토한다.
 * 사용자 작업 폴더는 건드리지 않는다. 결과 브랜치를 작업 폴더에 합칠지는 부르는 쪽이 정한다.
 */
export async function aggregate(
  env: PlannedEnv,
  plan: Plan,
  input: { repoRoot: string; base: string; subdir: string; ident: string; runTag: string; branches: Array<{ key: string; branch: string }>; implementers: Route[] },
): Promise<AggregateResult> {
  const { config, settings, log, classification, ctx } = env;
  const policy = config.routing.results;
  const result: AggregateResult = { ok: false, branch: null, head: null, resolutions: [], tests: null, review: null, stat: "", files: [], attempts: [] };
  const dir = path.join(settings.worktreeRoot, `${safeRef(input.ident)}-${input.runTag}`, "_result");
  let wt: Worktree | null = null;
  let link: string | null = null;
  try {
    wt = await serialGit(async () => addWorktree(input.repoRoot, dir, await uniqueBranch(input.repoRoot, `nexus/${safeRef(input.ident)}/result`), input.base));
    result.branch = wt.branch;
    await log(`하위 작업 결과를 ${wt.branch} 브랜치에 차례로 합쳐요.`);

    // 1. 차례로 합치기. 충돌하면 AI에게 한 번 풀게 한다.
    for (const { key, branch } of input.branches) {
      const merged = await mergeKeepConflicts(wt, branch);
      if (merged.ok) continue;
      if (!merged.conflicts.length || !policy.resolveConflicts || ctx.signal?.aborted) {
        await abortMerge(wt);
        result.error = merged.conflicts.length ? `${branch}를 합치다 충돌했어요 (${merged.conflicts.join(", ")}).` : `${branch}를 합치지 못했어요: ${merged.message}`;
        return result;
      }
      await log(`${branch}를 합치다 충돌이 났어요 (${merged.conflicts.join(", ")}). AI에게 풀어 달라고 할게요.`);
      const routes = planRoutes({ taskType: "implement", risk: "high" }, config, { isCoolingDown: (id) => env.state.isUnavailable(id) });
      const attempts = await runRoutes(
        routes,
        { cwd: wt.dir, prompt: conflictPrompt(plan, key, merged.conflicts, env.issue.identifier ?? env.issue.id), timeoutSec: Math.min(settings.timeoutSec, 900), onLog: ctx.onLog, signal: ctx.signal },
        env.executors,
        env.state,
        (line) => log(`[충돌 해결] ${line}`),
        undefined,
        { issue: env.issue.identifier ?? env.issue.id, purpose: "conflict" },
      );
      result.attempts.push(...attempts);
      const remaining = filesWithConflictMarkers(wt.dir, merged.conflicts);
      const ok = Boolean(attempts.at(-1)?.outcome.ok) && remaining.length === 0;
      result.resolutions.push({ branch, files: merged.conflicts, ok, attempts });
      if (!ok) {
        await abortMerge(wt);
        result.error = `${branch}를 합치다 생긴 충돌을 AI가 풀지 못했어요${remaining.length ? ` (남은 충돌: ${remaining.join(", ")})` : ""}.`;
        return result;
      }
      await concludeMerge(wt);
    }
    const d = await diffBetween(wt.dir, input.base, "HEAD");
    result.head = await headOf(wt.dir);
    result.stat = d.stat;
    result.files = d.files;
    result.ok = true;

    // 2. 합친 결과로 테스트
    const projectDir = path.join(wt.dir, input.subdir);
    if (policy.runTests && !ctx.signal?.aborted) {
      link = linkNodeModules(path.join(input.repoRoot, input.subdir), projectDir);
      await log("합친 결과로 테스트를 돌려요.");
      result.tests = await runTests(projectDir, policy.testCommand, { timeoutSec: Math.min(settings.timeoutSec, 1800), signal: ctx.signal });
      await log(`테스트: ${result.tests.status}${result.tests.command ? ` (${result.tests.command})` : ""}`);
    }

    // 3. 구현과 다른 회사 모델이 전체 변경을 검토
    if (policy.review && d.diff && !ctx.signal?.aborted) {
      const review = await crossReview(env, {
        implementers: input.implementers,
        stat: d.stat,
        diff: d.diff,
        tests: result.tests,
        cwd: projectDir,
        intro: `여러 AI가 하위 작업 ${plan.subtasks.length}개로 나눠 구현한 결과를 하나로 합쳤어요. 당신은 구현에 참여하지 않은 검토자입니다.`,
      });
      if (review) {
        result.review = review;
        result.attempts.push(...review.attempts);
      }
    }
    return result;
  } catch (err) {
    if (wt) await abortMerge(wt);
    result.ok = false;
    result.error = `결과를 합치는 중 오류가 났어요: ${(err as Error).message}`;
    return result;
  } finally {
    if (link) unlinkDir(link);
    if (wt) await cleanupWorktree(wt, log);
  }
}

/**
 * worktree에는 node_modules가 없어서 테스트가 엉뚱하게 실패한다.
 * 원래 폴더의 node_modules를 링크로 연결한다(Windows는 관리자 권한이 필요 없는 junction).
 */
function linkNodeModules(fromDir: string, toDir: string): string | null {
  const source = path.join(fromDir, "node_modules");
  const target = path.join(toDir, "node_modules");
  if (!existsSync(source) || existsSync(target) || !existsSync(toDir)) return null;
  try {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return target;
  } catch {
    return null;
  }
}

/** 링크만 지운다. 링크가 가리키는 원래 폴더는 건드리지 않는다. */
function unlinkDir(link: string): void {
  try {
    if (!lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    unlinkSync(link);
  } catch {
    try {
      rmdirSync(link);
    } catch {
      /* 남아도 worktree 정리 때 링크로 지워진다 */
    }
  }
}

export function parseVerdict(text: string): Review["verdict"] {
  const m = text.match(/판정\s*[:：]\s*\**\s*(문제\s*없음|확인\s*필요)/);
  if (!m) return "unknown";
  return m[1]!.replace(/\s/g, "") === "문제없음" ? "ok" : "attention";
}

function conflictPrompt(plan: Plan, key: string, files: string[], ident: string): string {
  const others = plan.subtasks.map((s) => `- ${s.key}: ${s.title}`).join("\n");
  return [
    `## Nexus 병합 충돌 해결 요청 (${ident})`,
    "",
    `여러 AI가 나눠서 한 작업을 합치는 중에 하위 작업 \`${key}\`의 브랜치를 합치다 충돌이 났어요.`,
    "",
    "전체 계획:",
    plan.summary,
    "",
    "하위 작업:",
    others,
    "",
    `충돌 파일: ${files.join(", ")}`,
    "",
    "할 일:",
    "1. 각 충돌 파일에서 <<<<<<<, =======, >>>>>>> 표시를 모두 없애고, 양쪽 변경의 의도를 모두 살려 하나로 합치세요.",
    "2. 충돌 파일 말고 다른 파일은 고치지 마세요.",
    "3. git commit은 하지 마세요. 합치기 마무리는 Nexus가 합니다.",
    "4. 마지막에 어떻게 합쳤는지 두세 줄로 알려 주세요.",
  ].join("\n");
}

export type ReviewEnv = Pick<PlannedEnv, "config" | "classification" | "state" | "executors" | "ctx" | "issue" | "log" | "settings">;

/** 구현에 쓰지 않은 회사의 모델에게 변경 전체를 읽기 전용으로 검토받는다. 쓸 모델이 없으면 null */
export async function crossReview(
  env: ReviewEnv,
  input: { implementers: Route[]; stat: string; diff: string; tests: TestRun | null; cwd: string; intro: string },
): Promise<Review | null> {
  const { config, classification, ctx, settings, log } = env;
  const used = new Set(input.implementers.map(routeProvider));
  const all = planRoutes({ taskType: "review", risk: classification.risk }, config, { isCoolingDown: (id) => env.state.isUnavailable(id) });
  const other = all.filter((r) => !used.has(routeProvider(r)));
  const routes = other.length ? other : all;
  if (!routes.length) return null;
  await log(`${other.length ? "다른 회사" : "같은 회사"} 모델에게 전체 변경 검토를 맡겨요.`);
  const attempts = await runRoutes(
    routes,
    { cwd: input.cwd, prompt: reviewPrompt(env, input.intro, input.stat, input.diff, input.tests), readOnly: true, timeoutSec: Math.min(settings.timeoutSec, 900), onLog: ctx.onLog, signal: ctx.signal },
    env.executors,
    env.state,
    (line) => log(`[검토] ${line}`),
    undefined,
    { issue: env.issue.identifier ?? env.issue.id, purpose: "review" },
  );
  const last = attempts.at(-1);
  return last?.outcome.ok
    ? { verdict: parseVerdict(last.outcome.summary), text: last.outcome.summary.trim(), sameProvider: !other.length, attempts }
    : { verdict: "unknown", text: `검토하지 못했어요: ${last?.outcome.errorMessage ?? "쓸 수 있는 모델이 없어요"}`, sameProvider: !other.length, attempts };
}

/** 결과 댓글의 테스트·검토 줄 */
export function checkLines(tests: TestRun | null, review: Review | null, ranTests: boolean): string[] {
  const lines: string[] = [];
  if (tests) {
    const desc = {
      passed: `통과 (\`${tests.command}\`, ${tests.durationSec ?? 0}초)`,
      failed: `실패 (\`${tests.command}\`)`,
      unavailable: `테스트 도구가 없어 돌리지 못했어요 (\`${tests.command}\`)`,
      none: "테스트를 찾지 못했어요",
    }[tests.status];
    lines.push(`- 테스트: ${desc}`);
    if (tests.status === "failed" && tests.output) lines.push("", "```", tests.output.split("\n").slice(-30).join("\n"), "```");
  } else if (ranTests) {
    lines.push("- 테스트: 돌리지 않음");
  }
  if (review) {
    const by = review.attempts.at(-1)?.route;
    const verdict = { ok: "문제 없음", attention: "확인 필요", unknown: "판정 없음" }[review.verdict];
    lines.push(`- 검토: ${verdict}${by ? ` · ${by.model}${review.sameProvider ? " (다른 회사 모델이 없어 같은 회사 모델로 검토)" : " (구현과 다른 회사 모델)"}` : ""}`);
    const body = review.text.replace(/^\**판정\s*[:：].*\n?/, "").trim();
    if (body) lines.push("", ...body.slice(0, 3000).split("\n").map((l) => `> ${l}`));
  }
  return lines;
}

function reviewPrompt(env: ReviewEnv, intro: string, stat: string, diff: string, tests: TestRun | null): string {
  const cut = diff.length > MAX_REVIEW_DIFF;
  const testLine = !tests
    ? "테스트: 돌리지 않음"
    : tests.status === "passed"
      ? `테스트: 통과 (${tests.command})`
      : tests.status === "failed"
        ? `테스트: 실패 (${tests.command})\n\`\`\`\n${(tests.output ?? "").slice(-1500)}\n\`\`\``
        : tests.status === "unavailable"
          ? `테스트: 도구가 없어 못 돌림 (${tests.command})`
          : "테스트: 찾지 못함";
  return [
    `## Nexus 전체 변경 검토 요청 (${env.issue.identifier ?? env.issue.id})`,
    "",
    `이슈: ${env.issue.title}`,
    env.issue.description ? `\n${env.issue.description.slice(0, 3000)}\n` : "",
    intro,
    "",
    testLine,
    "",
    "바뀐 파일:",
    "```",
    stat,
    "```",
    "",
    `전체 변경${cut ? ` (길어서 앞부분 ${MAX_REVIEW_DIFF}자만)` : ""}:`,
    "```diff",
    cut ? diff.slice(0, MAX_REVIEW_DIFF) : diff,
    "```",
    "",
    "검토할 것: 이슈 요구를 빠짐없이 했는지, 하위 작업끼리 맞물리지 않는 부분, 버그, 보안 문제, 빠진 테스트.",
    "파일을 고치지 말고 의견만 주세요. 답의 첫 줄은 반드시 `판정: 문제 없음` 또는 `판정: 확인 필요` 중 하나로 쓰고,",
    "그 아래에 발견한 문제를 중요한 순서로 짧은 목록으로 적어 주세요. 문제가 없으면 목록은 생략해도 됩니다.",
  ].join("\n");
}
