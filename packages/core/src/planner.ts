import type { PlanningPolicy, Plan, Subtask, TaskType } from "@nexus/shared";
import { detectTaskType } from "./classifier.ts";

const TASK_TYPES: TaskType[] = ["design", "implement", "refactor", "test", "review", "docs", "research", "ops"];
const SPLIT_LABELS = ["plan", "split", "분해", "나눠서"];
const NO_SPLIT_LABELS = ["no-plan", "single", "단일", "나누지마"];

export interface PlanDecisionInput {
  title: string;
  description?: string | null;
  labels?: string[];
}

/** 이 이슈를 하위 작업으로 나눌지 정한다. 작은 이슈를 나누면 시간과 한도만 더 쓴다. */
export function shouldPlan(input: PlanDecisionInput, policy: PlanningPolicy): { plan: boolean; reason: string } {
  const labels = (input.labels ?? []).map((l) => l.toLowerCase().replace(/\s+/g, ""));
  if (policy.mode === "never") return { plan: false, reason: "설정에서 작업 나누기를 끔" };
  if (labels.some((l) => NO_SPLIT_LABELS.includes(l))) return { plan: false, reason: "나누지 않음 라벨" };
  if (policy.mode === "always") return { plan: true, reason: "설정에서 항상 나누기" };
  if (labels.some((l) => SPLIT_LABELS.includes(l))) return { plan: true, reason: "나누기 라벨" };

  const text = input.description ?? "";
  const items = text.split(/\r?\n/).filter((l) => /^\s*(?:(?:[-*+]|\d+[.)]|\[[ xX]\])\s+|[•·▪●○◦]\s*)\S/.test(l)).length;
  if (items >= 3) return { plan: true, reason: `할 일 목록 ${items}개` };
  if (text.length >= 600) return { plan: true, reason: "설명이 김" };
  return { plan: false, reason: "작은 이슈" };
}

export const PLAN_MARKER = "## Nexus 작업 분해 요청";

export function buildPlanPrompt(p: { identifier?: string | null; title: string; description?: string | null; cwd: string; maxSubtasks: number }): string {
  const head = p.identifier ? `[${p.identifier}] ${p.title}` : p.title;
  return [
    PLAN_MARKER,
    "",
    `Paperclip 이슈를 여러 AI가 나눠 맡을 수 있게 하위 작업으로 나눠 주세요: ${head}`,
    "파일은 고치지 말고, 필요하면 작업 폴더의 코드를 읽기만 하세요.",
    "",
    "## 이슈 내용",
    p.description?.trim() || "(설명 없음)",
    "",
    "## 나누는 규칙",
    `- 하위 작업은 2개 이상 ${p.maxSubtasks}개 이하. 나눌 필요가 없으면 1개만 적으세요.`,
    "- 각 하위 작업은 혼자서 끝낼 수 있게, 다른 작업자가 이슈를 못 본다고 생각하고 지시를 구체적으로 적으세요.",
    "- 같은 파일을 여러 작업이 고치지 않게 나누고, 각 작업이 주로 건드릴 파일이나 폴더를 files에 적으세요.",
    "- 앞 작업의 결과가 필요하면 dependsOn에 그 작업의 key를 적으세요. 테스트·리뷰는 보통 구현에 의존합니다.",
    `- taskType은 ${TASK_TYPES.join(", ")} 중 하나.`,
    "",
    "## 응답 형식",
    "설명 없이 아래 형식의 JSON 하나만 ```json 코드 블록으로 답하세요.",
    "```json",
    JSON.stringify(
      {
        summary: "전체 계획 한두 문장",
        subtasks: [
          { key: "api", title: "검색 API 추가", taskType: "implement", files: ["src/api/search.ts"], dependsOn: [], instructions: "구체적인 지시" },
          { key: "test", title: "검색 API 테스트", taskType: "test", files: ["tests/search.test.ts"], dependsOn: ["api"], instructions: "구체적인 지시" },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export class PlanError extends Error {}

/** AI가 돌려준 계획을 읽고 검사한다. 고칠 수 있는 것은 고치고, 못 쓰면 PlanError */
export function parsePlan(text: string, maxSubtasks: number): Plan {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") throw new PlanError("응답에서 JSON 계획을 찾지 못했어요");
  const obj = raw as { summary?: unknown; subtasks?: unknown };
  if (!Array.isArray(obj.subtasks) || obj.subtasks.length === 0) throw new PlanError("subtasks가 비어 있어요");

  const used = new Set<string>();
  const subtasks: Subtask[] = [];
  const keyMap = new Map<string, string>();
  for (const [i, item] of obj.subtasks.slice(0, maxSubtasks).entries()) {
    const s = (item ?? {}) as Record<string, unknown>;
    const title = str(s.title) ?? `하위 작업 ${i + 1}`;
    const instructions = str(s.instructions) ?? title;
    let key = (str(s.key) ?? `t${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `t${i + 1}`;
    while (used.has(key)) key = `${key}-${i + 1}`;
    used.add(key);
    keyMap.set(str(s.key) ?? key, key);
    const taskType = TASK_TYPES.includes(s.taskType as TaskType) ? (s.taskType as TaskType) : detectTaskType(`${title}\n${instructions}`.toLowerCase());
    const files = Array.isArray(s.files) ? s.files.map((f) => normalizePath(String(f))).filter(Boolean) : [];
    const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [];
    subtasks.push({ key, title: title.slice(0, 200), instructions, taskType, files, dependsOn });
  }
  for (const s of subtasks) {
    s.dependsOn = [...new Set(s.dependsOn.map((d) => keyMap.get(d) ?? d).filter((d) => d !== s.key && used.has(d)))];
  }
  if (hasCycle(subtasks)) throw new PlanError("하위 작업의 순서가 서로를 기다리는 고리로 되어 있어요");
  return { summary: str(obj.summary) ?? "", subtasks: addOverlapDependencies(subtasks) };
}

/**
 * 같은 파일·폴더를 건드리는 작업은 동시에 돌리면 결과를 합칠 때 충돌한다.
 * 목록에서 뒤에 있는 작업이 앞 작업을 기다리게 해 순서대로 쌓이게 한다.
 */
export function addOverlapDependencies(subtasks: Subtask[]): Subtask[] {
  const out = subtasks.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = out[j]!;
      const b = out[i]!;
      if (b.dependsOn.includes(a.key) || dependsOnTransitively(out, a.key, b.key)) continue;
      if (overlaps(a.files, b.files)) b.dependsOn.push(a.key);
    }
  }
  return out;
}

export function overlaps(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

function dependsOnTransitively(list: Subtask[], from: string, target: string): boolean {
  const byKey = new Map(list.map((s) => [s.key, s]));
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length) {
    const k = stack.pop()!;
    if (k === target) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(byKey.get(k)?.dependsOn ?? []));
  }
  return false;
}

function hasCycle(list: Subtask[]): boolean {
  const byKey = new Map(list.map((s) => [s.key, s]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of byKey.get(k)?.dependsOn ?? []) if (visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  return list.some((s) => visit(s.key));
}

export type SubtaskStatus = "done" | "failed" | "skipped";

/**
 * 의존 순서를 지키며 최대 concurrency개씩 동시에 실행한다.
 * 앞 작업이 실패하면 그 작업을 기다리던 작업은 건너뛴다.
 */
export async function runSchedule<R extends { ok: boolean }>(
  subtasks: Subtask[],
  concurrency: number,
  run: (s: Subtask, index: number) => Promise<R>,
  onSkip?: (s: Subtask, failedDeps: string[]) => Promise<void> | void,
): Promise<Map<string, { status: SubtaskStatus; result?: R }>> {
  const results = new Map<string, { status: SubtaskStatus; result?: R }>();
  const pending = new Set(subtasks.map((s) => s.key));
  const running = new Map<string, Promise<void>>();
  const limit = Math.max(1, concurrency);

  while (pending.size || running.size) {
    for (const s of subtasks) {
      if (!pending.has(s.key)) continue;
      const failedDeps = s.dependsOn.filter((d) => results.has(d) && results.get(d)!.status !== "done");
      if (failedDeps.length) {
        pending.delete(s.key);
        results.set(s.key, { status: "skipped" });
        await onSkip?.(s, failedDeps);
        continue;
      }
      if (running.size >= limit) continue;
      if (!s.dependsOn.every((d) => results.get(d)?.status === "done")) continue;
      pending.delete(s.key);
      const index = subtasks.indexOf(s);
      running.set(
        s.key,
        run(s, index)
          .then((r) => void results.set(s.key, { status: r.ok ? "done" : "failed", result: r }))
          .catch(() => void results.set(s.key, { status: "failed" }))
          .finally(() => running.delete(s.key)),
      );
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size) {
      // 의존 대상이 목록에 없는 경우 등으로 더 진행할 수 없으면 남은 작업을 건너뛴다.
      for (const k of pending) results.set(k, { status: "skipped" });
      pending.clear();
    }
  }
  return results;
}

function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = [...fences, text.trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
