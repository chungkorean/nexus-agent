import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PaperclipClient } from "@nexus/paperclip-client";
import { appendUsage, listArchive, readUsage, writeTelegramSettings } from "@nexus/shared";
import { defaultDeps, executeDispatch, type DispatchDeps } from "../../packages/paperclip-adapter/src/server/execute.ts";
import { readSettings, withResultPolicy } from "../../packages/paperclip-adapter/src/settings.ts";
import { testDispatchEnvironment } from "../../packages/paperclip-adapter/src/server/test.ts";
import type { AdapterExecutionContext } from "../../packages/paperclip-adapter/src/adapter-types.ts";
import { FakePaperclip } from "../fakes/fake-paperclip.ts";
import { FAKE_TOKEN, FakeTelegram } from "../fakes/fake-telegram.ts";

const FAKES = path.resolve(import.meta.dirname, "../fakes");
const FAKE_OPENCODE = [process.execPath, path.join(FAKES, "fake-opencode.mjs")];
const FAKE_CLAUDE = [process.execPath, path.join(FAKES, "fake-claude.mjs")];
const REPO_CONFIG = path.resolve(import.meta.dirname, "../../config");

let paperclip: FakePaperclip;
let tmp: string;
let workdir: string;
let logs: string[];

function readLog(file: string): Array<Record<string, any>> {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function ctx(config: Record<string, unknown> = {}, context: Record<string, unknown> = { taskId: "NEX-1" }): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-dev", companyId: "co-1", name: "개발 부서", adapterType: "nexus_dispatch", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: workdir,
      configDir: REPO_CONFIG,
      opencodeCommand: FAKE_OPENCODE,
      claudeCommand: FAKE_CLAUDE,
      timeoutSec: 60,
      ...config,
    },
    context,
    authToken: "agent-jwt",
    onLog: async (_s, chunk) => {
      logs.push(chunk);
    },
  };
}

const deps: DispatchDeps = { ...defaultDeps, client: (c) => new PaperclipClient(paperclip.url, c.authToken, c.runId) };

beforeAll(async () => {
  paperclip = new FakePaperclip();
  await paperclip.start();
});
afterAll(async () => {
  await paperclip.stop();
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-e2e-"));
  workdir = path.join(tmp, "work");
  execFileSync("git", ["init", "-q", workdir]);
  logs = [];
  paperclip.comments.length = 0;
  paperclip.created.length = 0;
  paperclip.requests.length = 0;
  paperclip.issues.clear();
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, "claude.log");
  process.env.FAKE_OPENCODE_LOG = path.join(tmp, "opencode.log");
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  process.env.NEXUS_HOME = path.join(tmp, "nexus-home");
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_OPENCODE_MODE;
  delete process.env.FAKE_CLAUDE_MEDIA;
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("nexus_dispatch 어댑터", () => {
  it("코딩 이슈를 Claude Code(구독)로 자동 실행하고 결과를 댓글로 남긴다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "목록 화면 버그 수정", description: "src/list.ts에서 빈 목록이 보여요", companyId: "co-1" });

    const result = await executeDispatch(ctx(), deps);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("sonnet");
    expect(result.billingType).toBe("subscription");
    expect(result.costUsd).toBeCloseTo(0.0456);
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 80, cachedInputTokens: 50 });

    const calls = readLog(process.env.FAKE_CLAUDE_LOG!);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "sonnet", "--dangerously-skip-permissions"]));
    expect(calls[0]!.prompt).toContain("목록 화면 버그 수정");
    expect(calls[0]!.hasApiKey).toBe(false); // 구독 계정으로 돌도록 API 키를 지운다
    expect(existsSync(path.join(workdir, "claude-output.txt"))).toBe(true);

    expect(paperclip.comments).toHaveLength(1);
    const comment = paperclip.comments[0]!.body;
    expect(comment).toContain("Nexus 실행 결과: 완료");
    expect(comment).toContain("Claude Code · sonnet");
    expect(comment).toContain("claude-output.txt");
    expect(paperclip.issues.get("NEX-1")!.status).toBe("done"); // 열어 두면 Paperclip이 다시 깨운다
    expect(paperclip.requests.every((r) => r.headers.authorization === "Bearer agent-jwt" && r.headers["x-paperclip-run-id"] === "run-1")).toBe(true);
  });

  it("끝난 작업과 만든 그림을 스튜디오 보관함에 남긴다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "주인공 콘셉트 그림 만들기", description: "src/art에 그림 파일을 만들어 줘", companyId: "co-1" });
    process.env.FAKE_CLAUDE_MEDIA = "art/hero.png";
    expect((await executeDispatch(ctx(), deps)).exitCode).toBe(0);
    const archive = listArchive(path.join(tmp, "nexus-home", "state"));
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({ identifier: "NEX-1", status: "완료", models: ["sonnet"], media: [{ name: "hero.png", source: "art/hero.png", kind: "image" }] });
    expect(logs.join("")).toContain("스튜디오에 모았어요");
  });

  it("한 번에 실행해도 바뀐 결과로 테스트를 돌리고 다른 회사 모델에게 검토받는다", async () => {
    writeFileSync(path.join(workdir, "README.md"), "hi\n");
    execFileSync("git", ["-C", workdir, "add", "."]);
    execFileSync("git", ["-C", workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1" });
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(0);
    const review = readLog(process.env.FAKE_OPENCODE_LOG!).find((c) => c.text.includes("전체 변경 검토 요청"))!;
    expect(review.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
    expect(review.text).toContain("+++ b/claude-output.txt");
    const comment = paperclip.comments[0]!.body;
    expect(comment).toContain("#### 확인");
    expect(comment).toContain("- 테스트: 테스트를 찾지 못했어요");
    expect(comment).toContain("- 검토: 문제 없음 · openai/gpt-5 (구현과 다른 회사 모델)");
    expect(comment).toContain("| claude-output.txt | 새 파일 |");

    // 테스트가 실패하면 확인 필요, 이슈는 막힘
    rmSync(path.join(workdir, "claude-output.txt"));
    writeFileSync(path.join(workdir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
    execFileSync("git", ["-C", workdir, "add", "."]);
    execFileSync("git", ["-C", workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pkg"]);
    paperclip.comments.length = 0;
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1" });
    const failedRun = await executeDispatch(ctx(), deps);
    expect(failedRun.exitCode).toBe(1);
    expect(paperclip.comments[0]!.body).toContain("### Nexus 실행 결과: 확인 필요");
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
  });

  it("조사 작업은 OpenCode의 긴 문맥 모델로 보낸다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 정렬이 느린 원인 분석", description: "코드베이스 분석으로 원인을 찾아 주세요", companyId: "co-1" });

    const result = await executeDispatch(ctx(), deps);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("google/gemini-2.5-pro");
    const prompts = readLog(process.env.FAKE_OPENCODE_LOG!);
    expect(prompts[0]!.model).toEqual({ providerID: "google", modelID: "gemini-2.5-pro" });
    expect(prompts[0]!.directory).toBe(workdir);
    expect(JSON.parse(prompts[0]!.env.config).permission.bash).toBe("allow");
    expect(paperclip.comments[0]!.body).toContain("opencode-output.txt");
    expect(result.costUsd).toBeCloseTo(0.0123);
  });

  it("비코딩 이슈는 Hermes 에이전트에게 하위 이슈로 넘긴다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "누아르 웹툰 세계관과 캐릭터 설정 정리", description: "스토리 설정 충돌을 찾아 주세요", companyId: "co-1", projectId: "proj-1" });

    const result = await executeDispatch(ctx({ nonCodingAgentId: "agent-hermes" }), deps);

    expect(result.exitCode).toBe(0);
    expect(paperclip.created).toHaveLength(1);
    expect(paperclip.created[0]).toMatchObject({ companyId: "co-1", input: { parentId: "NEX-1", assigneeAgentId: "agent-hermes", projectId: "proj-1", status: "todo" } });
    expect(paperclip.comments[0]!.body).toContain("비코딩 작업으로 판단");
    expect(readLog(process.env.FAKE_CLAUDE_LOG!)).toHaveLength(0);
  });

  it("한도에 걸리면 대체 순서의 다음 모델로 넘어간다", async () => {
    const cfgDir = path.join(tmp, "cfg");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(path.join(cfgDir, "models.yaml"), readFileSync(path.join(REPO_CONFIG, "models.yaml")));
    writeFileSync(
      path.join(cfgDir, "routing.yaml"),
      readFileSync(path.join(REPO_CONFIG, "routing.yaml"), "utf8").replace("implement: [coder, smart]", "implement: [coder, reviewer]"),
    );
    process.env.FAKE_CLAUDE_MODE = "quota";
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "검색 기능 구현", description: "검색 함수를 추가", companyId: "co-1" });

    const result = await executeDispatch(ctx({ configDir: cfgDir }), deps);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("openai/gpt-5");
    expect((result.resultJson!.attempts as unknown[]).length).toBe(2);
    expect(paperclip.comments[0]!.body).toContain("coder(provider_quota) 실패 후 reviewer로 넘어감");
  });

  it("이번 달 예산을 다 쓴 계정은 건너뛰고 다음 모델로 넘어가며, 모든 실행을 사용량에 기록한다", async () => {
    const cfgDir = path.join(tmp, "cfg");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      path.join(cfgDir, "models.yaml"),
      readFileSync(path.join(REPO_CONFIG, "models.yaml"), "utf8").replace("    model: sonnet\n", "    model: sonnet\n    accounts: [claude-main]\n"),
    );
    writeFileSync(
      path.join(cfgDir, "routing.yaml"),
      readFileSync(path.join(REPO_CONFIG, "routing.yaml"), "utf8").replace("implement: [coder, smart]", "implement: [coder, reviewer]"),
    );
    writeFileSync(path.join(cfgDir, "accounts.yaml"), "accounts:\n  claude-main:\n    engine: claude-code\n    label: 개인\n    monthlyTokenLimit: 100\n");
    const stateDir = path.join(tmp, "nexus-home", "state");
    appendUsage(stateDir, {
      at: new Date().toISOString(), alias: "coder", engine: "claude-code", model: "sonnet", accountId: "claude-main", ok: true,
      inputTokens: 80, outputTokens: 40, cachedInputTokens: 0, costUsd: 0, durationMs: 1,
    });
    paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "검색 기능 구현", description: "검색 함수를 추가", companyId: "co-1" });

    const result = await executeDispatch(ctx({ configDir: cfgDir }), deps);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("openai/gpt-5");
    expect(logs.join("")).toContain("이번 달 토큰 한도 100개를 다 썼어요");
    const usage = readUsage(stateDir);
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ issue: "NEX-1", purpose: "implement", alias: "reviewer", model: "openai/gpt-5", ok: true });
    expect(usage[1]!.accountId).toBeUndefined();
  });

  it("텔레그램을 연결해 두었으면 결과를 알린다", async () => {
    const tg = new FakeTelegram();
    await tg.start();
    process.env.NEXUS_TELEGRAM_API = tg.url;
    try {
      writeTelegramSettings(path.join(tmp, "nexus-home", "state"), { enabled: true, notifyResults: true, botToken: FAKE_TOKEN, chats: [{ id: 7, name: "정" }] });
      paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "검색 기능 구현", companyId: "co-1" });
      const result = await executeDispatch(ctx(), deps);
      expect(result.exitCode).toBe(0);
      expect(tg.sent).toHaveLength(1);
      expect(tg.sent[0]!.text.split("\n")[0]).toBe("✅ NEX-1 Nexus 실행 결과: 완료");
    } finally {
      delete process.env.NEXUS_TELEGRAM_API;
      await tg.stop();
    }
  });

  it("작업 자체가 실패하면 다른 모델로 반복하지 않고 실패로 보고한다", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "검색 기능 구현", companyId: "co-1" });
    // auth는 공급자 문제라 다음(smart, 역시 Claude)으로 넘어가지만 둘 다 실패한다
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("/login");
    expect(paperclip.comments[0]!.body).toContain("Nexus 실행 결과: 실패");
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
  });

  it("예상하지 못한 오류가 나도 이슈에 알리고 막힘으로 표시한다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "검색 기능 구현", companyId: "co-1" });
    const broken: DispatchDeps = {
      ...deps,
      accountState: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };
    const result = await executeDispatch(ctx(), broken);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("unexpected_error");
    expect(paperclip.comments.at(-1)!.body).toContain("EPERM");
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
  });

  it("설정 화면(routing.yaml)의 결과 처리 값을 쓰고, 에이전트 설정에 값이 있으면 그것이 우선한다", async () => {
    const policy = { autoMerge: false, markDoneOnSuccess: false };
    const base = readSettings({});
    expect(withResultPolicy(base, {}, policy)).toMatchObject(policy);
    expect(withResultPolicy(base, { autoMerge: "true", markDoneOnSuccess: true }, policy)).toMatchObject({ autoMerge: true, markDoneOnSuccess: true });
  });

  it("markDoneOnSuccess를 끄면 성공해도 이슈 상태를 바꾸지 않는다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1", status: "in_progress" });
    const result = await executeDispatch(ctx({ markDoneOnSuccess: false }), deps);
    expect(result.exitCode).toBe(0);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("in_progress");
  });

  it("이미 완료한 이슈가 다시 열려도 사람 댓글이 없으면 다시 실행하지 않는다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1", status: "in_progress" });
    const first = await executeDispatch(ctx(), deps);
    expect(first.exitCode).toBe(0);
    expect(readLog(process.env.FAKE_CLAUDE_LOG!)).toHaveLength(1);

    paperclip.issues.get("NEX-1")!.status = "todo"; // Paperclip이 다시 열었다고 치자
    const again = await executeDispatch(ctx({}, { taskId: "NEX-1", wakeReason: "issue_assigned" }), deps);
    expect(again.exitCode).toBe(0);
    expect(readLog(process.env.FAKE_CLAUDE_LOG!)).toHaveLength(1);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("done");

    // 사람이 댓글로 다시 요청하면 실행한다
    paperclip.comments.push({ issueId: "NEX-1", body: "한 번 더 해 주세요", authorType: "user" });
    paperclip.issues.get("NEX-1")!.status = "todo";
    await executeDispatch(ctx({}, { taskId: "NEX-1", wakeReason: "issue_commented" }), deps);
    expect(readLog(process.env.FAKE_CLAUDE_LOG!)).toHaveLength(2);
  });

  it("이미 끝난 이슈나 마무리 확인 하트비트에서는 다시 실행하지 않는다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1", status: "done" });
    const closed = await executeDispatch(ctx(), deps);
    expect(closed.exitCode).toBe(0);
    expect(closed.summary).toContain("완료");

    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "목록 화면 버그 수정", companyId: "co-1", status: "in_progress" });
    const handoff = await executeDispatch(ctx({}, { taskId: "NEX-1", wakeReason: "finish_successful_run_handoff" }), deps);
    expect(handoff.exitCode).toBe(0);
    const children = await executeDispatch(ctx({}, { taskId: "NEX-1", wakeReason: "issue_children_completed" }), deps);
    expect(children.exitCode).toBe(0);

    expect(readLog(process.env.FAKE_CLAUDE_LOG!)).toHaveLength(0);
    expect(readLog(process.env.FAKE_OPENCODE_LOG!)).toHaveLength(0);
    expect(paperclip.comments).toHaveLength(0);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("in_progress");
  });

  it("git 저장소가 아닌 폴더에서도 동작한다", async () => {
    workdir = mkdtempSync(path.join(os.tmpdir(), "nexus-plain-"));
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "sales.xlsx 파싱 스크립트 실행", companyId: "co-1" });
    const result = await executeDispatch(ctx({ cwd: workdir }), deps);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(workdir, "claude-output.txt"))).toBe(true);
  });

  it("작업 폴더가 없으면 이슈에 알리고 실패한다", async () => {
    paperclip.issues.set("NEX-1", { id: "NEX-1", title: "버그 수정", companyId: "co-1" });
    const result = await executeDispatch(ctx({ cwd: path.join(tmp, "nope") }), deps);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("cwd_missing");
    expect(paperclip.comments[0]!.body).toContain("작업 폴더가 없어요");
  });

  it("배정된 이슈가 없으면 아무것도 하지 않는다", async () => {
    const result = await executeDispatch(ctx({}, {}), deps);
    expect(result.exitCode).toBe(0);
    expect(paperclip.requests).toHaveLength(0);
  });

  it("환경 점검은 설정, 작업 폴더, 실행 파일을 확인한다", async () => {
    const res = await testDispatchEnvironment({ companyId: "co-1", adapterType: "nexus_dispatch", config: ctx().config });
    expect(res.status).toBe("warn"); // nonCodingAgentId가 없어서 경고
    expect(res.checks.map((c) => c.code)).toEqual(expect.arrayContaining(["cwd_ok", "config_ok", "opencode_ok", "claude_ok", "no_delegate"]));
    const bad = await testDispatchEnvironment({ companyId: "co-1", adapterType: "nexus_dispatch", config: { ...ctx().config, claudeCommand: "definitely-not-claude" } });
    expect(bad.status).toBe("fail");
  });
});
