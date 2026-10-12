import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { PaperclipClient } from "@nexus/paperclip-client";
import { AccountState } from "@nexus/shared";
import { defaultDeps, executeDispatch, type DispatchDeps } from "../../packages/paperclip-adapter/src/server/execute.ts";
import type { AdapterExecutionContext } from "../../packages/paperclip-adapter/src/adapter-types.ts";
import { FakePaperclip } from "../fakes/fake-paperclip.ts";

const FAKES = path.resolve(import.meta.dirname, "../fakes");
const REPO_CONFIG = path.resolve(import.meta.dirname, "../../config");

let paperclip: FakePaperclip;
let tmp: string;
let workdir: string;
let cfgDir: string;

const deps: DispatchDeps = { ...defaultDeps, client: (c) => new PaperclipClient(paperclip.url, c.authToken, c.runId) };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const readLog = (file: string): Array<Record<string, any>> =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const accDir = (id: string) => path.join(tmp, "accounts", id);

function ctx(config: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-dev", companyId: "co-1", name: "개발 부서", adapterType: "nexus_dispatch", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: workdir,
      configDir: cfgDir,
      opencodeCommand: [process.execPath, path.join(FAKES, "fake-opencode.mjs")],
      claudeCommand: [process.execPath, path.join(FAKES, "fake-claude.mjs")],
      timeoutSec: 60,
      worktreeRoot: path.join(tmp, "wt"),
      accountsDir: path.join(tmp, "accounts"),
      stateDir: path.join(tmp, "state"),
      ...config,
    },
    context: { taskId: "NEX-1" },
    authToken: "agent-jwt",
    onLog: async () => {},
  };
}

/** 계정 셋(Claude 둘, OpenAI 하나)과 항상 나누기 설정을 만든다. */
function writeConfig(routingPatch: Record<string, unknown> = {}) {
  mkdirSync(cfgDir, { recursive: true });
  const models = parse(readFileSync(path.join(REPO_CONFIG, "models.yaml"), "utf8"));
  models.aliases.coder.accounts = ["claude-a", "claude-b"];
  models.aliases.smart.accounts = ["claude-a", "claude-b"];
  models.aliases.reviewer.accounts = ["oc-main"];
  writeFileSync(path.join(cfgDir, "models.yaml"), stringify(models));
  const routing = parse(readFileSync(path.join(REPO_CONFIG, "routing.yaml"), "utf8"));
  writeFileSync(path.join(cfgDir, "routing.yaml"), stringify({ ...routing, ...routingPatch, planning: { ...routing.planning, mode: "always", ...(routingPatch.planning as object) } }));
  writeFileSync(
    path.join(cfgDir, "accounts.yaml"),
    stringify({
      accounts: {
        "claude-a": { engine: "claude-code", label: "Claude 개인" },
        "claude-b": { engine: "claude-code", label: "Claude 회사" },
        "oc-main": { engine: "opencode", provider: "openai", label: "ChatGPT" },
      },
    }),
  );
}

function setPlan(subtasks: unknown[], summary = "검색 기능을 셋으로 나눔") {
  process.env.FAKE_CLAUDE_PLAN = JSON.stringify({ summary, subtasks });
  process.env.FAKE_OPENCODE_PLAN = process.env.FAKE_CLAUDE_PLAN;
}

beforeAll(async () => {
  paperclip = new FakePaperclip();
  await paperclip.start();
});
afterAll(async () => {
  await paperclip.stop();
  for (const k of ["FAKE_CLAUDE_PLAN", "FAKE_OPENCODE_PLAN", "FAKE_CLAUDE_DELAY_MS", "FAKE_OPENCODE_DELAY_MS", "FAKE_CLAUDE_QUOTA_DIRS", "FAKE_CLAUDE_MODE"]) delete process.env[k];
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-plan-"));
  workdir = path.join(tmp, "work");
  cfgDir = path.join(tmp, "cfg");
  execFileSync("git", ["init", "-q", "-b", "main", workdir]);
  writeFileSync(path.join(workdir, "README.md"), "hello\n");
  git(workdir, "add", ".");
  git(workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  paperclip.comments.length = 0;
  paperclip.created.length = 0;
  paperclip.requests.length = 0;
  paperclip.issues.clear();
  paperclip.issues.set("NEX-1", { id: "NEX-1", identifier: "NEX-1", title: "검색 기능 추가", description: "- API\n- 화면\n- 리뷰", companyId: "co-1", projectId: "proj-1" });
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, "claude.log");
  process.env.FAKE_OPENCODE_LOG = path.join(tmp, "opencode.log");
  process.env.FAKE_CLAUDE_DELAY_MS = "400";
  process.env.FAKE_OPENCODE_DELAY_MS = "400";
  delete process.env.FAKE_CLAUDE_QUOTA_DIRS;
  delete process.env.FAKE_CLAUDE_MODE;
  writeConfig();
});

const THREE = [
  { key: "api", title: "검색 API", taskType: "implement", files: ["src/api"], dependsOn: [], instructions: "API를 만드세요" },
  { key: "ui", title: "검색 화면", taskType: "implement", files: ["src/ui"], dependsOn: [], instructions: "화면을 만드세요" },
  { key: "review", title: "보안 검토", taskType: "review", files: ["docs/review.md"], dependsOn: [], instructions: "검토하세요" },
];

describe("작업 분해와 병렬 실행", () => {
  it("하위 작업 셋을 서로 다른 모델·계정으로 동시에 실행하고 Paperclip 하위 이슈로 보여 준다", async () => {
    // Windows는 git과 프로세스 시작이 느려 하위 작업 시작 시각이 1초 넘게 벌어질 수 있다.
    // 작업 시간을 넉넉히 잡아야 "동시에 돌았다"를 확인할 수 있다.
    process.env.FAKE_CLAUDE_DELAY_MS = "3000";
    process.env.FAKE_OPENCODE_DELAY_MS = "3000";
    setPlan(THREE);
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(0);

    // 계획은 읽기 전용으로 세운다
    const claude = readLog(process.env.FAKE_CLAUDE_LOG!);
    const planCall = claude.find((c) => c.prompt.includes("## Nexus 작업 분해 요청"))!;
    expect(planCall.args).toContain("--disallowedTools");
    expect(planCall.args).not.toContain("--dangerously-skip-permissions");

    // 하위 이슈: 상위 이슈 아래, 담당자 없음, 끝나면 done
    expect(paperclip.created).toHaveLength(3);
    for (const c of paperclip.created) {
      expect(c.input).toMatchObject({ parentId: "NEX-1", projectId: "proj-1", status: "todo" });
      expect(c.input.assigneeAgentId).toBeUndefined();
    }
    expect([...paperclip.issues.values()].filter((i) => i.parentId === "NEX-1").map((i) => i.status)).toEqual(["done", "done", "done"]);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("done");

    // 서로 다른 계정·모델, 그리고 실제로 동시에
    const work = claude.filter((c) => !c.prompt.includes("작업 분해 요청") && !c.prompt.includes("전체 변경 검토 요청"));
    const ocAll = readLog(process.env.FAKE_OPENCODE_LOG!).filter((c) => !c.text.includes("작업 분해 요청"));
    const oc = ocAll.filter((c) => !c.text.includes("전체 변경 검토 요청"));
    expect(work.map((c) => c.claudeConfigDir).sort()).toEqual([accDir("claude-a"), accDir("claude-b")]);
    expect(oc).toHaveLength(1);
    expect(oc[0]!.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
    expect(oc[0]!.env.XDG_DATA_HOME).toBe(accDir("oc-main"));
    const spans = [...work, ...oc].map((c) => [c.startedAt, c.endedAt] as const);
    const latestStart = Math.max(...spans.map((s) => s[0]));
    const earliestEnd = Math.min(...spans.map((s) => s[1]));
    expect(latestStart).toBeLessThan(earliestEnd);

    // 결과는 하위 작업별 브랜치 커밋으로 남고, 모두 성공했으니 작업 폴더에도 합쳐진다
    expect(git(workdir, "show", "nexus/NEX-1/api:api.txt")).toContain("sonnet");
    expect(git(workdir, "show", "nexus/NEX-1/review:review.txt")).toContain("opencode");
    expect(readFileSync(path.join(workdir, "api.txt"), "utf8")).toContain("sonnet");
    expect(existsSync(path.join(workdir, "review.txt"))).toBe(true);
    expect(git(workdir, "status", "--porcelain")).toBe("");
    expect(git(workdir, "worktree", "list").split("\n")).toHaveLength(1);

    const parentComments = paperclip.comments.filter((c) => c.issueId === "NEX-1").map((c) => c.body);
    expect(parentComments[0]).toContain("Nexus 작업 계획: 하위 작업 3개");
    expect(parentComments[1]).toContain("Nexus 실행 결과: 완료 (3/3)");
    expect(parentComments[1]).toContain("자동으로 합쳤어요");
    // 합친 뒤 검토: 구현에 Anthropic과 OpenAI를 모두 써서 같은 회사 모델(review 순서의 첫 번째)로 검토
    const review = ocAll.find((c) => c.text.includes("전체 변경 검토 요청"))!;
    expect(review.agent).toBe("plan");
    expect(review.text).toContain("+made by fake claude sonnet");
    expect(parentComments[1]).toContain("- 검토: 문제 없음 · openai/gpt-5 (다른 회사 모델이 없어 같은 회사 모델로 검토)");
    expect(parentComments[1]).toContain("- 테스트: 테스트를 찾지 못했어요");
    expect(parentComments[1]).toContain("#### 모델별 사용량");
    expect(result.resultJson!.merged).toMatchObject({ branch: expect.any(String) });
    expect(result.billingType).toBe("unknown");
    expect((result.resultJson!.subtasks as unknown[]).length).toBe(3);
  });

  it("autoMerge를 끄거나 작업 폴더에 커밋하지 않은 변경이 있으면 합치지 않고 명령만 알려 준다", async () => {
    setPlan(THREE.slice(0, 2));
    await executeDispatch(ctx({ autoMerge: false }), deps);
    expect(existsSync(path.join(workdir, "api.txt"))).toBe(false);
    let summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("자동 합치기가 꺼져 있어요.");
    expect(summary).toContain("git merge nexus/NEX-1/result");

    paperclip.comments.length = 0;
    paperclip.issues.get("NEX-1")!.status = "todo";
    writeFileSync(path.join(workdir, "README.md"), "편집 중\n");
    await executeDispatch(ctx(), deps);
    expect(existsSync(path.join(workdir, "api.txt"))).toBe(false);
    expect(readFileSync(path.join(workdir, "README.md"), "utf8")).toBe("편집 중\n");
    summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("자동으로 합치지 못했어요. 작업 폴더에 커밋하지 않은 변경이 있어요.");
    expect(summary).toContain("git merge nexus/NEX-1/result-2");
  });

  it("하위 작업끼리 같은 파일에서 충돌하면 AI가 풀고, 다른 회사 모델이 검토한 뒤 작업 폴더에 합친다", async () => {
    process.env.FAKE_SHARED_FILE = "shared.txt";
    setPlan([
      { key: "a", title: "A", taskType: "implement", files: ["a"], dependsOn: [] },
      { key: "b", title: "B", taskType: "implement", files: ["b"], dependsOn: [] },
    ]);
    const result = await executeDispatch(ctx(), deps);
    delete process.env.FAKE_SHARED_FILE;
    expect(result.exitCode).toBe(0);
    const resolve = readLog(process.env.FAKE_CLAUDE_LOG!).find((c) => c.prompt.includes("병합 충돌 해결 요청"))!;
    expect(resolve.model).toBe("opus"); // highRiskAlias(smart)
    expect(resolve.prompt).toContain("충돌 파일: shared.txt");
    const merged = readFileSync(path.join(workdir, "shared.txt"), "utf8");
    expect(merged).toContain("for a");
    expect(merged).toContain("for b");
    expect(merged).not.toMatch(/<{7}|>{7}/);
    // 구현은 모두 Claude였으니 검토는 다른 회사(OpenAI) 모델
    expect(readLog(process.env.FAKE_OPENCODE_LOG!).some((c) => c.text.includes("전체 변경 검토 요청"))).toBe(true);
    const summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("충돌 해결: `nexus/NEX-1/b` (shared.txt) → AI가 풀었어요 · opus");
    expect(summary).toContain("(구현과 다른 회사 모델)");
    expect(summary).toContain("자동으로 합쳤어요");
  });

  it("충돌을 풀지 못하면 작업 폴더를 건드리지 않고 막힘으로 남긴다", async () => {
    process.env.FAKE_SHARED_FILE = "shared.txt";
    process.env.FAKE_RESOLVE = "fail";
    setPlan([
      { key: "a", title: "A", taskType: "implement", files: ["a"], dependsOn: [] },
      { key: "b", title: "B", taskType: "implement", files: ["b"], dependsOn: [] },
    ]);
    const result = await executeDispatch(ctx(), deps);
    delete process.env.FAKE_SHARED_FILE;
    delete process.env.FAKE_RESOLVE;
    expect(result.exitCode).toBe(1);
    expect(existsSync(path.join(workdir, "shared.txt"))).toBe(false);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
    const summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("### Nexus 실행 결과: 확인 필요 (2/2)");
    expect(summary).toContain("AI가 풀지 못했어요");
    expect(summary).toContain("git merge nexus/NEX-1/a nexus/NEX-1/b");
    expect(git(workdir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("합친 결과가 테스트에 실패하면 작업 폴더에 합치지 않는다", async () => {
    writeFileSync(path.join(workdir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('1 failed'); process.exit(1)\"" } }));
    git(workdir, "add", ".");
    git(workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pkg");
    setPlan(THREE.slice(0, 2));
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(1);
    expect(existsSync(path.join(workdir, "api.txt"))).toBe(false);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
    const summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("### Nexus 실행 결과: 확인 필요 (2/2)");
    expect(summary).toContain("- 테스트: 실패 (`npm test`)");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("테스트를 통과하지 못해서 작업 폴더에 합치지 않았어요.");
    expect(summary).toContain("git merge nexus/NEX-1/result");
  });

  it("테스트를 통과하고 검토자가 확인이 필요하다고 하면 합치지 않고 의견을 남긴다", async () => {
    writeFileSync(path.join(workdir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    git(workdir, "add", ".");
    git(workdir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pkg");
    process.env.FAKE_REVIEW_VERDICT = "확인 필요";
    setPlan(THREE.slice(0, 2));
    const result = await executeDispatch(ctx(), deps);
    delete process.env.FAKE_REVIEW_VERDICT;
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(workdir, "api.txt"))).toBe(false);
    const summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("- 테스트: 통과 (`npm test`");
    expect(summary).toContain("- 검토: 확인 필요");
    expect(summary).toContain("> - 가짜");
    expect(summary).toContain("검토자가 확인이 필요하다고 해서");
  });

  it("뒤 작업은 앞 작업의 브랜치를 합친 상태에서 시작한다", async () => {
    setPlan([
      { key: "impl", title: "구현", taskType: "implement", files: ["src/search.ts"], dependsOn: [] },
      { key: "test", title: "테스트", taskType: "test", files: ["tests/search.test.ts"], dependsOn: ["impl"] },
    ]);
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(0);
    expect(git(workdir, "show", "nexus/NEX-1/test:impl.txt")).toContain("sonnet");
    expect(git(workdir, "show", "nexus/NEX-1/test:test.txt")).toContain("haiku");
  });

  it("한도에 걸린 계정은 쉬게 하고 다음 계정으로 넘어간다", async () => {
    process.env.FAKE_CLAUDE_QUOTA_DIRS = accDir("claude-a");
    setPlan(THREE.slice(0, 2));
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(0);
    const work = readLog(process.env.FAKE_CLAUDE_LOG!).filter((c) => !c.prompt.includes("작업 분해 요청") && c.claudeConfigDir === accDir("claude-b"));
    expect(work.length).toBeGreaterThanOrEqual(2);
    expect(new AccountState(path.join(tmp, "state")).get("claude-a")).toMatchObject({ reason: "provider_quota" });
  });

  it("하위 작업이 실패하면 기다리던 작업은 건너뛰고 실패로 보고한다", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth";
    writeConfig({ planning: { planner: "reviewer" } });
    setPlan([
      { key: "impl", title: "구현", taskType: "implement", dependsOn: [] },
      { key: "test", title: "테스트", taskType: "test", dependsOn: ["impl"] },
      { key: "review", title: "검토", taskType: "review", dependsOn: [] },
    ]);
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(1);
    const children = [...paperclip.issues.values()].filter((i) => i.parentId === "NEX-1");
    expect(children.map((i) => i.status)).toEqual(["blocked", "blocked", "done"]);
    expect(paperclip.issues.get("NEX-1")!.status).toBe("blocked");
    const summary = paperclip.comments.filter((c) => c.issueId === "NEX-1").at(-1)!.body;
    expect(summary).toContain("일부 실패 (1/3)");
    expect(summary).toContain("앞 작업(impl)이 끝나지 않아 건너뛰었어요");
  });

  it("git 저장소가 아니면 같은 폴더에서 하나씩 실행한다", async () => {
    workdir = mkdtempSync(path.join(os.tmpdir(), "nexus-plain-"));
    setPlan(THREE.slice(0, 2));
    const result = await executeDispatch(ctx({ cwd: workdir }), deps);
    expect(result.exitCode).toBe(0);
    expect(readdirSync(workdir).sort()).toEqual(["api.txt", "ui.txt"]);
    expect(paperclip.comments.at(-1)!.body).toContain("한 번에 하나씩");
  });

  it("계획을 읽지 못하면 나누지 않고 한 번에 실행한다", async () => {
    process.env.FAKE_CLAUDE_PLAN = "이건 JSON이 아니에요";
    const result = await executeDispatch(ctx(), deps);
    expect(result.exitCode).toBe(0);
    expect(paperclip.created).toHaveLength(0);
    // 설명에 "리뷰"가 있어 리뷰 모델(OpenCode)로 한 번에 실행된다
    expect(existsSync(path.join(workdir, "opencode-output.txt"))).toBe(true);
    expect(paperclip.comments.at(-1)!.body).toContain("Nexus 실행 결과: 완료");
  });
});
