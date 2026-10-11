import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountState, ConfigError, validateConfig, type Classification } from "@nexus/shared";
import { planRoutes } from "./router.ts";

const models = {
  aliases: {
    coder: { engine: "claude-code", model: "sonnet", accounts: ["claude-a", "claude-b"] },
    smart: { engine: "claude-code", model: "opus", accounts: ["claude-a"] },
    reviewer: { engine: "opencode", model: "openai/gpt-5", accounts: ["oc-main"] },
    local: { engine: "opencode", model: "ollama/qwen3-coder" },
  },
};
const types = ["design", "implement", "refactor", "test", "review", "docs", "research", "ops"];
const routing = { taskTypes: Object.fromEntries(types.map((t) => [t, ["coder", "smart"]])), maxFallbacks: 1 };
const accounts = {
  accounts: {
    "claude-a": { engine: "claude-code", label: "개인 구독" },
    "claude-b": { engine: "claude-code", label: "회사 구독", dir: "D:/acc/b" },
    "oc-main": { engine: "opencode", provider: "openai" },
  },
};
const config = validateConfig(models, routing, accounts, "/acc");
const impl: Classification = { decision: "execute", taskType: "implement", risk: "low", reasons: [] };

describe("계정", () => {
  it("계정 폴더를 정하고 별칭에 연결한다", () => {
    expect(config.accounts["claude-a"]).toMatchObject({ dir: path.join("/acc", "claude-a"), provider: "anthropic", label: "개인 구독" });
    expect(config.accounts["claude-b"]!.dir).toBe("D:/acc/b");
    expect(config.accounts["oc-main"]!.label).toBe("oc-main");
    expect(config.routing.planning).toEqual({ mode: "auto", maxSubtasks: 5, concurrency: 3, planner: "smart" });
  });

  it("같은 별칭의 다른 계정은 대체 횟수에 세지 않는다", () => {
    const routes = planRoutes(impl, config);
    expect(routes.map((r) => `${r.alias}/${r.accountId}`)).toEqual(["coder/claude-a", "coder/claude-b", "smart/claude-a"]);
    expect(routes[0]!.accountDir).toBe(path.join("/acc", "claude-a"));
  });

  it("spread로 하위 작업마다 시작 계정을 돌리고, 쉬는 계정은 뺀다", () => {
    expect(planRoutes(impl, config, { spread: 1 }).map((r) => r.accountId)).toEqual(["claude-b", "claude-a", "claude-a"]);
    expect(planRoutes(impl, config, { isCoolingDown: (id) => id === "claude-a" }).map((r) => `${r.alias}/${r.accountId}`)).toEqual(["coder/claude-b"]);
  });

  it("없는 계정이나 엔진이 다른 계정을 가리키면 알려 준다", () => {
    const bad = { aliases: { ...models.aliases, reviewer: { engine: "opencode", model: "openai/gpt-5", accounts: ["claude-a", "nope"] } } };
    try {
      validateConfig(bad, routing, accounts, "/acc");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("계정 claude-a은 claude-code용");
      expect((err as Error).message).toContain("없는 계정 nope");
    }
  });
});

describe("AccountState", () => {
  it("한도에 걸린 계정을 정해진 시간 동안 쉬게 하고 파일로 공유한다", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-state-"));
    let now = Date.parse("2026-10-11T00:00:00Z");
    const a = new AccountState(dir, () => now);
    expect(a.report("claude-a", "task_failed")).toBe(false);
    expect(a.report("claude-a", "provider_quota", "limit")).toBe(true);
    expect(a.isCoolingDown("claude-a")).toBe(true);
    expect(new AccountState(dir, () => now).get("claude-a")).toMatchObject({ reason: "provider_quota", until: "2026-10-11T01:00:00.000Z" });
    now += 61 * 60_000;
    expect(a.isCoolingDown("claude-a")).toBe(false);
    a.report("claude-b", "provider_auth");
    a.clear("claude-b");
    expect(new AccountState(dir, () => now).all()).toEqual({});
  });
});
