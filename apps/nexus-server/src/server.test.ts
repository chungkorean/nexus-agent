import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AccountState, appendUsage, type UsageEntry } from "@nexus/shared";
import { createSettingsServer, type LoginCommand, type SettingsServer } from "./server.ts";

const repoConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config");

const ROUTING = `# 사용자 주석: 맨 위
defaultWhenUnsure: execute
preferLocal: false
lightTaskTypes: [test, docs]
highRiskAlias: smart
# 넘어가는 횟수 주석
maxFallbacks: 1
taskTypes:
  design: [smart, coder]
  implement: [coder, smart, fast] # 구현 줄 주석
  refactor: [coder, smart]
  test: [fast, coder]
  docs: [fast, coder]
  research: [longctx, smart]
  ops: [coder, smart]
  review: [reviewer, smart]
planning:
  # 나누기 주석
  mode: auto
  maxSubtasks: 5
  concurrency: 3
  planner: smart
`;

const MODELS = `aliases:
  smart:
    engine: claude-code
    model: opus
    label: "Claude Opus"
  coder:
    engine: claude-code
    model: sonnet
    label: "Claude Sonnet"
  fast:
    engine: claude-code
    model: haiku
    label: "Claude Haiku"
  longctx:
    engine: opencode
    model: google/gemini-2.5-pro
    label: "Gemini Pro"
  reviewer:
    engine: opencode
    model: openai/gpt-5
    label: "GPT"
`;

const ACCOUNTS = `# 계정 주석
accounts:
  claude-main:
    engine: claude-code
    provider: anthropic
    label: "Claude 개인"
  openai-main:
    engine: opencode
    provider: openai
    label: "ChatGPT 계정"
`;

let tmp: string;
let configDir: string;
let fallbackDir: string;
let stateDir: string;
let accountsDir: string;
let srv: SettingsServer;
let base: string;
let launched: LoginCommand[];

function writeConfig(dir: string, files: { models?: string; routing?: string; accounts?: string } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "models.yaml"), files.models ?? MODELS);
  writeFileSync(path.join(dir, "routing.yaml"), files.routing ?? ROUTING);
  writeFileSync(path.join(dir, "accounts.yaml"), files.accounts ?? ACCOUNTS);
}

async function start(opts: { fillUser?: boolean } = {}) {
  if (opts.fillUser !== false) writeConfig(configDir);
  srv = createSettingsServer({
    configDir,
    fallbackDir,
    stateDir,
    accountsDir,
    port: 0,
    launcher: async (cmd) => {
      launched.push(cmd);
      return { launched: true };
    },
  });
  base = await srv.listen();
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(p, base), {
    method: "POST",
    headers: { "content-type": "application/json", "x-nexus": "1", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function getState() {
  const res = await fetch(new URL("/api/state", base));
  return { status: res.status, body: (await res.json()) as any };
}

/** fetch는 Host 머리글을 바꿀 수 없어서 http 모듈로 보낸다. */
function rawRequest(p: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, path: p, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const read = (name: string) => readFileSync(path.join(configDir, name), "utf8");

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-settings-"));
  configDir = path.join(tmp, "config");
  fallbackDir = path.join(tmp, "fallback");
  stateDir = path.join(tmp, "state");
  accountsDir = path.join(tmp, "accounts");
  writeConfig(fallbackDir);
  launched = [];
});

afterEach(async () => {
  await srv?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("settings server", () => {
  it("copies missing config files from the fallback folder on first run", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "models.yaml"), MODELS.replace('"Claude Opus"', '"내가 고친 Opus"'));
    await start({ fillUser: false });
    expect(existsSync(path.join(configDir, "routing.yaml"))).toBe(true);
    expect(existsSync(path.join(configDir, "accounts.yaml"))).toBe(true);
    // 이미 있던 파일은 덮어쓰지 않는다.
    expect(read("models.yaml")).toContain("내가 고친 Opus");
  });

  it("works with the repo's bundled config", async () => {
    fallbackDir = repoConfig;
    await start({ fillUser: false });
    const { status, body } = await getState();
    expect(status).toBe(200);
    expect(body.aliases.length).toBeGreaterThan(0);
  });

  it("returns everything the page needs", async () => {
    new AccountState(stateDir).report("claude-main", "provider_quota", "한도");
    await start();
    const { status, body } = await getState();
    expect(status).toBe(200);
    expect(body.configDir).toBe(configDir);
    expect(body.aliases.find((a: any) => a.name === "coder")).toMatchObject({ label: "Claude Sonnet", engine: "claude-code", model: "sonnet", accounts: [] });
    const main = body.accounts.find((a: any) => a.id === "claude-main");
    expect(main).toMatchObject({ engine: "claude-code", provider: "anthropic", label: "Claude 개인", dir: path.join(accountsDir, "claude-main"), loggedIn: false });
    expect(main.cooldown.reason).toBe("provider_quota");
    expect(body.accounts.find((a: any) => a.id === "openai-main").cooldown).toBeNull();
    expect(body.taskTypes.map((t: any) => t.name)).toEqual(["설계", "구현", "리팩터", "테스트 작성", "리뷰", "문서", "조사·분석", "터미널·파일 작업"]);
    expect(body.taskTypes.find((t: any) => t.id === "implement").chain).toEqual(["coder", "smart", "fast"]);
    expect(body.routing).toMatchObject({ preferLocal: false, maxFallbacks: 1, highRiskAlias: "smart", planning: { mode: "auto", concurrency: 3, maxSubtasks: 5 } });
  });

  it("serves the page and nothing outside the public folder", async () => {
    await start();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("작업별 담당 AI");
    expect(await rawRequest("/..%2f..%2fpackage.json", { host: new URL(base).host })).toBe(404);
    expect(await rawRequest("/../server.ts", { host: new URL(base).host })).toBe(404);
  });

  it("saves a new first choice and keeps comments and 3rd+ entries", async () => {
    await start();
    const { status, body } = await post("/api/save", { taskTypes: { implement: { first: "reviewer", second: "smart" } }, maxFallbacks: 2 });
    expect(status).toBe(200);
    expect(body.message).toContain("다음 작업부터");
    const text = read("routing.yaml");
    expect(text).toContain("# 사용자 주석: 맨 위");
    expect(text).toContain("# 넘어가는 횟수 주석");
    expect(text).toContain("# 구현 줄 주석");
    expect(text).toContain("# 나누기 주석");
    expect(text).toContain("implement: [reviewer, smart, fast]");
    const parsed = parse(text);
    expect(parsed.maxFallbacks).toBe(2);
    expect(parsed.taskTypes.design).toEqual(["smart", "coder"]);
    // 고치지 않은 파일은 건드리지 않는다.
    expect(read("models.yaml")).toBe(MODELS);
    // 백업이 남는다.
    const backups = readdirSync(path.join(configDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(configDir, "backups", backups[0]!, "routing.yaml"), "utf8")).toBe(ROUTING);
  });

  it("saves alias labels, models, accounts and planning", async () => {
    await start();
    const { status } = await post("/api/save", {
      aliases: { coder: { label: "코딩 담당", model: "opus", accounts: ["claude-main"] } },
      preferLocal: true,
      highRiskAlias: "coder",
      planning: { mode: "always", concurrency: 2, maxSubtasks: 4 },
      taskTypes: { docs: { first: "coder", second: null } },
    });
    expect(status).toBe(200);
    const models = parse(read("models.yaml"));
    expect(models.aliases.coder).toEqual({ engine: "claude-code", model: "opus", label: "코딩 담당", accounts: ["claude-main"] });
    const routing = parse(read("routing.yaml"));
    expect(routing.preferLocal).toBe(true);
    expect(routing.highRiskAlias).toBe("coder");
    expect(routing.planning).toMatchObject({ mode: "always", concurrency: 2, maxSubtasks: 4, planner: "smart" });
    expect(routing.taskTypes.docs).toEqual(["coder"]);

    // 계정을 모두 빼면 accounts 줄이 사라진다.
    await post("/api/save", { aliases: { coder: { accounts: [] } } });
    expect(parse(read("models.yaml")).aliases.coder.accounts).toBeUndefined();
  });

  it("saves the after-run toggles", async () => {
    await start();
    const state = await getState();
    expect(state.body.routing.results).toMatchObject({ autoMerge: true, markDoneOnSuccess: true, review: true, runTests: true });
    const preview = await post("/api/preview", { results: { autoMerge: false } });
    expect(preview.body.sentences).toContain("성공하면 결과를 작업 폴더에 자동으로 합치기: 켜짐 → 꺼짐");
    const { status } = await post("/api/save", { results: { autoMerge: false } });
    expect(status).toBe(200);
    expect(parse(read("routing.yaml")).results).toMatchObject({ autoMerge: false });
    expect((await getState()).body.routing.results).toMatchObject({ autoMerge: false, markDoneOnSuccess: true });

    await post("/api/save", { results: { review: false, testCommand: "  python -m pytest -q  " } });
    expect(parse(read("routing.yaml")).results).toMatchObject({ autoMerge: false, review: false, testCommand: "python -m pytest -q" });
    expect((await post("/api/save", { results: { testCommand: "a\nb" } })).status).toBe(400);
    await post("/api/save", { results: { githubPush: true, githubPullRequest: true, githubRemote: "upstream" } });
    expect(parse(read("routing.yaml")).results).toMatchObject({ githubPush: true, githubPullRequest: true, githubRemote: "upstream" });
    expect((await post("/api/save", { results: { githubRemote: "bad name; rm" } })).status).toBe(400);

    const bad = await post("/api/save", { results: { markDoneOnSuccess: "yes" } });
    expect(bad.status).toBe(400);
  });

  it("rejects an invalid save and writes nothing", async () => {
    await start();
    const { status, body } = await post("/api/save", { aliases: { coder: { accounts: ["openai-main"] } }, maxFallbacks: 2 });
    expect(status).toBe(400);
    expect(body.error).toContain("저장하지 않았어요");
    expect(body.problems.join("\n")).toContain("openai-main");
    expect(read("models.yaml")).toBe(MODELS);
    expect(read("routing.yaml")).toBe(ROUTING);
    expect(existsSync(path.join(configDir, "backups"))).toBe(false);

    const range = await post("/api/save", { maxFallbacks: 7, planning: { concurrency: 9 } });
    expect(range.status).toBe(400);
    expect(range.body.problems).toHaveLength(2);
    const same = await post("/api/save", { taskTypes: { test: { first: "fast", second: "fast" } } });
    expect(same.status).toBe(400);
    expect(read("routing.yaml")).toBe(ROUTING);
  });

  it("describes changes in plain Korean using labels", async () => {
    await start();
    const { status, body } = await post("/api/preview", {
      taskTypes: { implement: { first: "reviewer", second: "smart" }, test: { first: "fast", second: null } },
      preferLocal: true,
      maxFallbacks: 0,
      planning: { mode: "never" },
      aliases: { fast: { label: "빠른 AI" } },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sentences).toContain("구현 작업의 1순위: Claude Sonnet → GPT");
    expect(body.sentences).toContain("테스트 작성 작업의 2순위: Claude Sonnet → 없음");
    expect(body.sentences).toContain("내 컴퓨터 모델 먼저 쓰기: 꺼짐 → 켜짐");
    expect(body.sentences).toContain("실패하면 다른 AI로 넘어가는 횟수: 1번 → 넘어가지 않음");
    expect(body.sentences).toContain("작업 나누기: 자동 → 안 함");
    expect(body.sentences).toContain("AI 모델 이름: Claude Haiku → 빠른 AI");
    // 미리 보기는 파일을 바꾸지 않는다.
    expect(read("routing.yaml")).toBe(ROUTING);

    const bad = await post("/api/preview", { aliases: { coder: { accounts: ["openai-main"] } } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems.length).toBeGreaterThan(0);
  });

  it("rolls back step by step", async () => {
    await start();
    expect((await post("/api/rollback", {})).status).toBe(404);
    await post("/api/save", { maxFallbacks: 2 });
    await post("/api/save", { maxFallbacks: 3 });
    expect(parse(read("routing.yaml")).maxFallbacks).toBe(3);
    const first = await post("/api/rollback", {});
    expect(first.status).toBe(200);
    expect(first.body.message).toContain("되돌렸어요");
    expect(parse(read("routing.yaml")).maxFallbacks).toBe(2);
    await post("/api/rollback", {});
    expect(read("routing.yaml")).toBe(ROUTING);
    const none = await post("/api/rollback", {});
    expect(none.status).toBe(404);
    expect(none.body.error).toContain("되돌릴");
  });

  it("keeps only the newest 20 backups", async () => {
    await start();
    for (let i = 0; i < 23; i++) await post("/api/save", { maxFallbacks: i % 2 === 0 ? 2 : 3 });
    expect(readdirSync(path.join(configDir, "backups"))).toHaveLength(20);
  });

  it("rejects foreign Host headers and requests without the CSRF header", async () => {
    await start();
    const port = new URL(base).port;
    expect(await rawRequest("/api/state", { host: `evil.example:${port}` })).toBe(403);
    expect(await rawRequest("/", { host: "127.0.0.1:1" })).toBe(403);
    expect(await rawRequest("/api/state", { host: `localhost:${port}` })).toBe(200);

    const noHeader = await fetch(new URL("/api/save", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxFallbacks: 2 }) });
    expect(noHeader.status).toBe(403);
    const formPost = await fetch(new URL("/api/save", base), { method: "POST", headers: { "content-type": "text/plain", "x-nexus": "1" }, body: "{}" });
    expect(formPost.status).toBe(403);
    const foreignOrigin = await post("/api/save", { maxFallbacks: 2 }, { origin: "http://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    expect(read("routing.yaml")).toBe(ROUTING);

    const big = await post("/api/save", { pad: "x".repeat(300 * 1024) });
    expect(big.status).toBe(413);
  });

  it("adds and removes accounts, refusing to remove one in use", async () => {
    await start();
    const added = await post("/api/accounts", { id: "claude-sub", engine: "claude-code", provider: "anthropic", label: "Claude 두 번째" });
    expect(added.status).toBe(200);
    expect(existsSync(path.join(accountsDir, "claude-sub"))).toBe(true);
    const text = read("accounts.yaml");
    expect(text).toContain("# 계정 주석");
    expect(parse(text).accounts["claude-sub"]).toEqual({ engine: "claude-code", provider: "anthropic", label: "Claude 두 번째" });

    expect((await post("/api/accounts", { id: "claude-sub", engine: "claude-code" })).status).toBe(409);
    expect((await post("/api/accounts", { id: "한글", engine: "claude-code" })).status).toBe(400);
    expect((await post("/api/accounts", { id: "ok-id", engine: "gpt" })).status).toBe(400);

    await post("/api/save", { aliases: { smart: { accounts: ["claude-sub"] } } });
    const refused = await post("/api/accounts/remove", { id: "claude-sub" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Claude Opus");
    expect(parse(read("accounts.yaml")).accounts["claude-sub"]).toBeDefined();

    await post("/api/save", { aliases: { smart: { accounts: [] } } });
    const removed = await post("/api/accounts/remove", { id: "claude-sub" });
    expect(removed.status).toBe(200);
    expect(parse(read("accounts.yaml")).accounts["claude-sub"]).toBeUndefined();
    expect((await post("/api/accounts/remove", { id: "nobody" })).status).toBe(404);
  });

  it("adds the first account to an empty accounts file", async () => {
    writeConfig(configDir, { accounts: "# 빈 목록\naccounts: {}\n" });
    await start({ fillUser: false });
    expect((await post("/api/accounts", { id: "openai-main", engine: "opencode", provider: "openai", label: "GPT 계정" })).status).toBe(200);
    expect(parse(read("accounts.yaml")).accounts["openai-main"].engine).toBe("opencode");
    expect((await post("/api/accounts/remove", { id: "openai-main" })).status).toBe(200);
    expect(parse(read("accounts.yaml")).accounts).toEqual({});
  });

  it("opens login with the right folder for each engine", async () => {
    await start();
    const claude = await post("/api/accounts/login", { id: "claude-main" });
    expect(claude.status).toBe(200);
    expect(claude.body.launched).toBe(true);
    expect(claude.body.message).toContain("/login");
    const opencode = await post("/api/accounts/login", { id: "openai-main" });
    expect(opencode.status).toBe(200);
    expect(launched).toEqual([
      { accountId: "claude-main", engine: "claude-code", command: "claude", args: [], env: { CLAUDE_CONFIG_DIR: path.join(accountsDir, "claude-main") } },
      { accountId: "openai-main", engine: "opencode", command: "opencode", args: ["auth", "login"], env: { XDG_DATA_HOME: path.join(accountsDir, "openai-main") } },
    ]);
    expect(existsSync(path.join(accountsDir, "openai-main"))).toBe(true);
  });

  it("adds one Google account (Antigravity) and opens its login without a folder", async () => {
    await start();
    const added = await post("/api/accounts", { id: "google", engine: "antigravity", provider: "openai", label: "내 Google" });
    expect(added.status).toBe(200);
    // 공급자는 언제나 antigravity로 둔다.
    expect(parse(read("accounts.yaml")).accounts.google).toEqual({ engine: "antigravity", provider: "antigravity", label: "내 Google" });
    const second = await post("/api/accounts", { id: "google-2", engine: "antigravity" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("하나만");

    expect((await getState()).body.accounts.find((a: any) => a.id === "google").loggedIn).toBe(false);
    const login = await post("/api/accounts/login", { id: "google" });
    expect(login.body.message).toContain("Google 계정");
    expect(launched.at(-1)).toMatchObject({ accountId: "google", engine: "antigravity", args: [], env: {} });
    expect(launched.at(-1)!.command).toMatch(/^agy$|antigravity-login\.cmd$/);
    // 로그인 정보는 파일로 볼 수 없어서, 로그인 창을 연 뒤부터 사용 가능으로 본다.
    expect((await getState()).body.accounts.find((a: any) => a.id === "google").loggedIn).toBe(true);
  });

  it("shows the command when the window cannot be opened", async () => {
    writeConfig(configDir);
    srv = createSettingsServer({ configDir, stateDir, accountsDir, port: 0, launcher: async () => ({ launched: false, commandText: "CLAUDE_CONFIG_DIR=/x claude" }) });
    base = await srv.listen();
    const res = await post("/api/accounts/login", { id: "claude-main" });
    expect(res.body).toMatchObject({ launched: false, commandText: "CLAUDE_CONFIG_DIR=/x claude" });
  });

  it("resets an account cooldown", async () => {
    new AccountState(stateDir).report("claude-main", "provider_quota");
    await start();
    expect((await getState()).body.accounts.find((a: any) => a.id === "claude-main").cooldown).not.toBeNull();
    const res = await post("/api/accounts/reset", { id: "claude-main" });
    expect(res.status).toBe(200);
    expect(new AccountState(stateDir).all()).toEqual({});
    expect((await getState()).body.accounts.find((a: any) => a.id === "claude-main").cooldown).toBeNull();
  });

  it("saves monthly budgets on accounts and clears them when emptied", async () => {
    await start();
    const preview = await post("/api/preview", { budgets: { "claude-main": { monthlyTokenLimit: 5000000 }, "openai-main": { monthlyBudgetUsd: 20 } } });
    expect(preview.body.sentences).toContain("Claude 개인의 월 토큰 한도: 없음 → 5,000,000개");
    expect(preview.body.sentences).toContain("ChatGPT 계정의 월 예산: 없음 → $20");
    expect((await post("/api/save", { budgets: { "claude-main": { monthlyTokenLimit: 5000000 }, "openai-main": { monthlyBudgetUsd: 20 } } })).status).toBe(200);
    expect(parse(read("accounts.yaml")).accounts["openai-main"]).toMatchObject({ monthlyBudgetUsd: 20 });
    expect(read("accounts.yaml")).toContain("# 계정 주석");
    const acc = (await getState()).body.accounts.find((a: any) => a.id === "claude-main");
    expect(acc.monthlyTokenLimit).toBe(5000000);

    await post("/api/save", { budgets: { "openai-main": { monthlyBudgetUsd: null } } });
    expect(parse(read("accounts.yaml")).accounts["openai-main"].monthlyBudgetUsd).toBeUndefined();
    expect((await post("/api/save", { budgets: { "openai-main": { monthlyBudgetUsd: -1 } } })).status).toBe(400);
    expect((await post("/api/save", { budgets: { "openai-main": { monthlyBudgetUsd: "abc" } } })).status).toBe(400);
    expect((await post("/api/save", { budgets: { nobody: { monthlyBudgetUsd: 1 } } })).status).toBe(400);
  });

  it("reports usage by account and model, budget progress and history hints", async () => {
    writeConfig(configDir, { accounts: ACCOUNTS.replace('label: "Claude 개인"', 'label: "Claude 개인"\n    monthlyTokenLimit: 1000') });
    const now = new Date().toISOString();
    const entry = (over: Partial<UsageEntry>): UsageEntry => ({
      at: now, alias: "coder", engine: "claude-code", model: "sonnet", accountId: "claude-main", ok: true,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.01, durationMs: 1000, purpose: "implement", ...over,
    });
    for (let i = 0; i < 6; i++) appendUsage(stateDir, entry({ ok: i < 2, errorFamily: i < 2 ? undefined : "task_failed" }));
    for (let i = 0; i < 4; i++) appendUsage(stateDir, entry({ alias: "smart", model: "opus" }));
    appendUsage(stateDir, entry({ alias: "reviewer", engine: "opencode", model: "openai/gpt-5", accountId: "openai-main", purpose: "review", costUsd: 0.5 }));
    appendUsage(stateDir, entry({ at: "2000-01-01T00:00:00.000Z" }));
    await start({ fillUser: false });

    const res = await fetch(new URL("/api/usage?period=month", base));
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.totals.runs).toBe(11);
    const claude = body.accounts.find((a: any) => a.id === "claude-main");
    expect(claude.totals).toMatchObject({ runs: 10, ok: 6, inputTokens: 1000, outputTokens: 500 });
    expect(claude.budget).toMatchObject({ monthlyTokenLimit: 1000, usedTokens: 1500 });
    expect(claude.budget.exceeded).toContain("토큰 한도");
    expect(body.models.find((m: any) => m.alias === "reviewer")).toMatchObject({ label: "GPT", totals: { runs: 1, costUsd: 0.5 } });
    expect(body.hints).toHaveLength(1);
    expect(body.hints[0]).toMatchObject({ purpose: "implement", alias: "coder", better: "smart" });
    expect(body.hints[0].text).toContain("Claude Sonnet의 성공률이 33%");
    expect(body.recent).toHaveLength(11);

    expect((await fetch(new URL("/api/usage?period=forever", base))).status).toBe(400);
  });

  it("adds, swaps and removes models, keeping task orders valid", async () => {
    await start();
    // 새 모델을 추가하면서 같은 저장에서 바로 1순위로 쓴다.
    const save = await post("/api/save", {
      newAliases: { "deepseek-flash": { engine: "opencode", model: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" } },
      taskTypes: { implement: { first: "deepseek-flash", second: "coder" } },
      planning: { planner: "coder" },
    });
    expect(save.status).toBe(200);
    expect(save.body.sentences).toContain("AI 모델 추가: DeepSeek V4.1 Flash");
    expect(save.body.sentences).toContain("작업을 나눌 AI: Claude Opus → Claude Sonnet");
    const models = parse(read("models.yaml"));
    expect(models.aliases["deepseek-flash"]).toEqual({ engine: "opencode", model: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" });
    let routing = parse(read("routing.yaml"));
    expect(routing.taskTypes.implement).toEqual(["deepseek-flash", "coder", "fast"]);
    expect(routing.planning.planner).toBe("coder");

    // fast만 쓰는 작업이 있으면 지우지 못하게 막는다.
    await post("/api/save", { taskTypes: { test: { first: "fast", second: null } } });
    const blocked = await post("/api/save", { removeAliases: ["fast"] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.problems.join("\n")).toContain("테스트 작성 작업에 쓸 AI가 하나도 남지 않아요");

    // 바꿔 주면 지워지고, 모든 순서에서 빠진다.
    const ok = await post("/api/save", { removeAliases: ["fast"], taskTypes: { test: { first: "coder", second: null } } });
    expect(ok.status).toBe(200);
    expect(parse(read("models.yaml")).aliases.fast).toBeUndefined();
    routing = parse(read("routing.yaml"));
    expect(routing.taskTypes.implement).toEqual(["deepseek-flash", "coder"]);
    expect(routing.taskTypes.docs).toEqual(["coder"]);
    expect(read("routing.yaml")).toContain("# 구현 줄 주석");

    // 위험한 작업이나 작업 나누기에 쓰는 모델은 못 지운다.
    const inUse = await post("/api/save", { removeAliases: ["smart"] });
    expect(inUse.status).toBe(400);
    expect(inUse.body.problems.join("\n")).toContain("위험한 작업에 먼저 쓸 AI");

    expect((await post("/api/save", { newAliases: { bad: { engine: "opencode", model: "no-slash" } } })).status).toBe(400);
    expect((await post("/api/save", { newAliases: { smart: { engine: "claude-code", model: "opus" } } })).status).toBe(400);
  });

  it("lists connected models from OpenCode and caches them", async () => {
    const fake = path.join(tmp, "fake-models.mjs");
    writeFileSync(fake, `console.log("deepseek/deepseek-flash\\n" + JSON.stringify({ name: "DeepSeek V4.1 Flash", cost: { input: 0.15, output: 0.6 }, limit: { context: 1000000 } }, null, 2) + "\\nxiaomi/mimo-v2-pro");`);
    writeConfig(configDir);
    srv = createSettingsServer({ configDir, fallbackDir, stateDir, accountsDir, port: 0, opencodeCommand: [process.execPath, fake] });
    base = await srv.listen();
    const res = (await (await fetch(new URL("/api/models", base))).json()) as any;
    expect(res.ok).toBe(true);
    expect(res.models.filter((m: any) => m.engine === "claude-code").length).toBeGreaterThan(3);
    expect(res.models.find((m: any) => m.id === "deepseek/deepseek-flash")).toMatchObject({ name: "DeepSeek V4.1 Flash", context: 1000000 });
    expect(res.models.find((m: any) => m.id === "xiaomi/mimo-v2-pro")).toMatchObject({ provider: "xiaomi" });
    expect(res.providers.xiaomi).toBe("Xiaomi MiMo");
    // Google 계정이 없으면 agy를 부르지 않는다.
    expect(res.models.some((m: any) => m.engine === "antigravity")).toBe(false);
    expect(existsSync(path.join(stateDir, "models-cache.json"))).toBe(true);
  });

  it("lists Google account models from agy when a Google account exists", async () => {
    const fakeAgy = path.resolve(import.meta.dirname, "../../../tests/fakes/fake-agy.mjs");
    const fakeOc = path.join(tmp, "fake-models.mjs");
    writeFileSync(fakeOc, `console.log("deepseek/deepseek-flash");`);
    writeConfig(configDir);
    srv = createSettingsServer({ configDir, fallbackDir, stateDir, accountsDir, port: 0, opencodeCommand: [process.execPath, fakeOc], agyCommand: [process.execPath, fakeAgy] });
    base = await srv.listen();
    expect((await post("/api/accounts", { id: "google", engine: "antigravity" })).status).toBe(200);
    const res = (await (await fetch(new URL("/api/models?refresh=1", base))).json()) as any;
    expect(res.models.find((m: any) => m.id === "gemini-3.1-pro-high")).toMatchObject({ engine: "antigravity", provider: "antigravity", name: "Gemini 3.1 Pro (High)", accounts: ["google"], featured: true });
    expect(res.providers.antigravity).toContain("Google");
    // Google 계정 모델을 작업에 쓸 수 있게 저장한다.
    expect((await post("/api/save", { newAliases: { "gemini-pro": { engine: "antigravity", model: "gemini-3.1-pro-high", accounts: ["google"] } } })).status).toBe(200);
    expect(parse(read("models.yaml")).aliases["gemini-pro"]).toMatchObject({ engine: "antigravity", model: "gemini-3.1-pro-high" });
  });

  it("reports a broken config file in Korean", async () => {
    writeConfig(configDir, { routing: "taskTypes: [oops\n" });
    await start({ fillUser: false });
    const { status, body } = await getState();
    expect(status).toBe(500);
    expect(body.error).toContain("routing.yaml");
  });
});
