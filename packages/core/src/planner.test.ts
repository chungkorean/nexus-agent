import { describe, expect, it } from "vitest";
import type { PlanningPolicy, Subtask } from "@nexus/shared";
import { addOverlapDependencies, parsePlan, PlanError, runSchedule, shouldPlan } from "./planner.ts";

const policy: PlanningPolicy = { mode: "auto", maxSubtasks: 5, concurrency: 3, planner: "smart" };
const st = (key: string, extra: Partial<Subtask> = {}): Subtask => ({ key, title: key, instructions: key, taskType: "implement", files: [], dependsOn: [], ...extra });

describe("shouldPlan", () => {
  it("작은 이슈는 나누지 않고, 할 일 목록이 3개 이상이면 나눈다", () => {
    expect(shouldPlan({ title: "버튼 색 바꾸기", description: "파란색으로" }, policy).plan).toBe(false);
    expect(shouldPlan({ title: "x", description: "• 하나\n• 둘\n•셋" }, policy).plan).toBe(true);
    expect(shouldPlan({ title: "x", description: "**굵게**\n---\n-붙임" }, policy).plan).toBe(false);
    expect(shouldPlan({ title: "검색 기능", description: "- API 추가\n- 화면 추가\n- 테스트 작성" }, policy)).toEqual({ plan: true, reason: "할 일 목록 3개" });
    expect(shouldPlan({ title: "x", description: "1. a\n2. b\n3) c" }, policy).plan).toBe(true);
  });

  it("라벨과 설정이 우선한다", () => {
    expect(shouldPlan({ title: "x", labels: ["분해"] }, policy).plan).toBe(true);
    expect(shouldPlan({ title: "x", description: "- a\n- b\n- c", labels: ["단일"] }, policy).plan).toBe(false);
    expect(shouldPlan({ title: "x" }, { ...policy, mode: "always" }).plan).toBe(true);
    expect(shouldPlan({ title: "x", labels: ["plan"] }, { ...policy, mode: "never" }).plan).toBe(false);
  });
});

describe("parsePlan", () => {
  it("코드 블록 안의 JSON을 읽고 키·종류·경로를 다듬는다", () => {
    const text = '계획입니다\n```json\n{"summary":"검색","subtasks":[{"key":"API 작업","title":"API","taskType":"implement","files":[".\\\\src\\\\api\\\\"],"dependsOn":[]},{"key":"t","title":"API 테스트 작성","files":["tests/a.test.ts"],"dependsOn":["API 작업","없는키"]}]}\n```';
    const plan = parsePlan(text, 5);
    expect(plan.summary).toBe("검색");
    expect(plan.subtasks[0]).toMatchObject({ key: "api", files: ["src/api"] });
    expect(plan.subtasks[1]).toMatchObject({ key: "t", taskType: "test", dependsOn: ["api"] });
  });

  it("최대 개수를 넘으면 자르고, 고리가 있으면 거절한다", () => {
    const many = { subtasks: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, title: `t${i}` })) };
    expect(parsePlan(JSON.stringify(many), 3).subtasks).toHaveLength(3);
    const cyc = { subtasks: [{ key: "a", title: "a", dependsOn: ["b"] }, { key: "b", title: "b", dependsOn: ["a"] }] };
    expect(() => parsePlan(JSON.stringify(cyc), 5)).toThrowError(PlanError);
    expect(() => parsePlan("JSON이 없어요", 5)).toThrowError(PlanError);
  });

  it("같은 파일·폴더를 건드리는 작업은 뒤 작업이 앞 작업을 기다린다", () => {
    const out = addOverlapDependencies([st("a", { files: ["src/api"] }), st("b", { files: ["src/ui"] }), st("c", { files: ["src/api/search.ts"] })]);
    expect(out.map((s) => s.dependsOn)).toEqual([[], [], ["a"]]);
  });
});

describe("runSchedule", () => {
  it("동시 실행 수와 의존 순서를 지킨다", async () => {
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const subtasks = [st("a"), st("b"), st("c"), st("d", { dependsOn: ["a", "b"] })];
    const results = await runSchedule(subtasks, 2, async (s) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      order.push(s.key);
      running--;
      return { ok: true };
    });
    expect(peak).toBe(2);
    expect(order.indexOf("d")).toBeGreaterThan(Math.max(order.indexOf("a"), order.indexOf("b")));
    expect([...results.values()].every((r) => r.status === "done")).toBe(true);
  });

  it("앞 작업이 실패하면 기다리던 작업은 건너뛴다", async () => {
    const skipped: string[] = [];
    const results = await runSchedule(
      [st("a"), st("b", { dependsOn: ["a"] }), st("c", { dependsOn: ["b"] }), st("d")],
      3,
      async (s) => ({ ok: s.key !== "a" }),
      (s) => void skipped.push(s.key),
    );
    expect(results.get("a")!.status).toBe("failed");
    expect(results.get("b")!.status).toBe("skipped");
    expect(results.get("c")!.status).toBe("skipped");
    expect(results.get("d")!.status).toBe("done");
    expect(skipped).toEqual(["b", "c"]);
  });
});
