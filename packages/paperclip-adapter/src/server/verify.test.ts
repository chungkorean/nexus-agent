import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdict, routeProvider } from "./aggregate.ts";
import { mergeGate, topoOrder } from "./planned.ts";
import { detectTestCommand, runTests } from "./verify.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "nexus-verify-"));

describe("테스트 명령 찾기", () => {
  it("package.json의 test 스크립트를 쓰고, 기본 자리표시자는 무시한다", () => {
    const d = tmp();
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectTestCommand(d)).toBeNull();
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectTestCommand(d)).toBe("npm test");
    writeFileSync(path.join(d, "pnpm-lock.yaml"), "");
    expect(detectTestCommand(d)).toBe("pnpm test");
  });

  it("tests/test_*.py가 있으면 pytest를 쓴다", () => {
    const d = tmp();
    expect(detectTestCommand(d)).toBeNull();
    mkdirSync(path.join(d, "tests"));
    writeFileSync(path.join(d, "tests", "test_hello.py"), "def test_x(): pass\n");
    expect(detectTestCommand(d)).toBe("python -m pytest -q");
  });

  it("테스트 도구가 없으면 실패가 아니라 못 돌린 것으로 본다", async () => {
    const d = tmp();
    const res = await runTests(d, "nexus-no-such-tool-xyz --version", { timeoutSec: 20 });
    expect(res.status).toBe("unavailable");
    const fail = await runTests(d, 'node -e "process.exit(3)"', { timeoutSec: 20 });
    expect(fail.status).toBe("failed");
  });
});

describe("취합 규칙", () => {
  it("검토 판정을 읽는다", () => {
    expect(parseVerdict("판정: 문제 없음\n- 좋아요")).toBe("ok");
    expect(parseVerdict("**판정: 확인 필요**\n- 버그")).toBe("attention");
    expect(parseVerdict("괜찮아 보여요")).toBe("unknown");
  });

  it("공급사를 엔진과 모델로 정한다", () => {
    expect(routeProvider({ engine: "claude-code", model: "sonnet" })).toBe("anthropic");
    expect(routeProvider({ engine: "opencode", model: "openai/gpt-5" })).toBe("openai");
  });

  it("테스트 실패, 검토 확인 필요, 높은 위험도면 자동으로 합치지 않는다", () => {
    const ok = { ok: true, branch: "r", head: "h", resolutions: [], tests: { status: "passed" as const }, review: null, stat: "", files: [], attempts: [] };
    expect(mergeGate(ok, "low", true).allowed).toBe(true);
    expect(mergeGate(ok, "low", false).allowed).toBe(false);
    expect(mergeGate({ ...ok, tests: { status: "failed" } }, "low", true).allowed).toBe(false);
    expect(mergeGate({ ...ok, tests: { status: "unavailable" } }, "low", true).allowed).toBe(true);
    expect(mergeGate({ ...ok, review: { verdict: "attention", text: "", sameProvider: false, attempts: [] } }, "low", true).allowed).toBe(false);
    expect(mergeGate(ok, "high", true)).toMatchObject({ allowed: false, reason: expect.stringContaining("위험도") });
  });

  it("의존 순서대로 합친다", () => {
    const s = (key: string, dependsOn: string[] = []) => ({ key, title: key, instructions: "", taskType: "implement" as const, files: [], dependsOn });
    expect(topoOrder({ summary: "", subtasks: [s("test", ["impl"]), s("docs", ["impl"]), s("impl")] }).map((x) => x.key)).toEqual(["impl", "test", "docs"]);
  });
});

describe("저절로 생기는 파일", () => {
  it("파이썬 캐시는 바뀐 파일에서 뺀다", async () => {
    const { diffSnapshots } = await import("@nexus/shared");
    const after = new Map([["hello.py", "??"], ["__pycache__/hello.cpython-310.pyc", "??"], ["tests/__pycache__/x.pyc", "??"], [".pytest_cache/v/cache", "??"]]);
    expect(diffSnapshots(new Map(), after).map((f) => f.file)).toEqual(["hello.py"]);
  });
});
