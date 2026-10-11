import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig, ConfigError, type Classification } from "@nexus/shared";
import { planRoutes } from "./router.ts";

const repoConfig = loadConfig(path.resolve(import.meta.dirname, "../../../config"));
const base: Classification = { decision: "execute", taskType: "implement", risk: "low", reasons: [] };

describe("planRoutes", () => {
  it("기본 설정: 구현은 Claude Sonnet, 대체는 Opus", () => {
    const routes = planRoutes(base, repoConfig);
    expect(routes.map((r) => [r.alias, r.engine, r.model])).toEqual([
      ["coder", "claude-code", "sonnet"],
      ["smart", "claude-code", "opus"],
    ]);
  });

  it("위험도 높음이면 smart가 먼저", () => {
    expect(planRoutes({ ...base, risk: "high" }, repoConfig)[0]!.alias).toBe("smart");
  });

  it("조사는 긴 문맥 모델(OpenCode)로", () => {
    expect(planRoutes({ ...base, taskType: "research" }, repoConfig)[0]).toMatchObject({ engine: "opencode", alias: "longctx" });
  });

  it("preferLocal이면 가벼운 작업을 로컬 모델에 먼저 맡긴다", () => {
    const cfg = { ...repoConfig, routing: { ...repoConfig.routing, preferLocal: true } };
    expect(planRoutes({ ...base, taskType: "docs" }, cfg)[0]!.alias).toBe("local");
    expect(planRoutes({ ...base, taskType: "implement" }, cfg)[0]!.alias).toBe("coder");
    expect(planRoutes({ ...base, taskType: "docs", risk: "high" }, cfg)[0]!.alias).toBe("smart");
  });
});

describe("validateConfig", () => {
  it("잘못된 설정은 이유를 모두 알려 준다", () => {
    expect(() =>
      validateConfig({ aliases: { a: { engine: "opencode", model: "no-slash" }, b: { engine: "x", model: "m" } } }, { taskTypes: { implement: ["zzz"] } }),
    ).toThrowError(ConfigError);
    try {
      validateConfig({ aliases: { a: { engine: "opencode", model: "no-slash" } } }, {});
    } catch (err) {
      expect((err as Error).message).toContain("provider/model");
      expect((err as Error).message).toContain("대체 순서가 비어");
    }
  });
});
