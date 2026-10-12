import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agyArgs, AntigravityExecutor, classifyError, promptArg } from "./index.ts";

const FAKE = path.resolve(import.meta.dirname, "../../../tests/fakes/fake-agy.mjs");
let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "nexus-agy-test-"));
  log = path.join(dir, "..", `${path.basename(dir)}.log`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "a.txt"), "a\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(log, { force: true });
  delete process.env.FAKE_AGY_MODE;
});

const exec = new AntigravityExecutor({ command: [process.execPath, FAKE] });
const run = (extra: Partial<Parameters<typeof exec.run>[0]> = {}) =>
  exec.run({ cwd: dir, model: "gemini-3.1-pro-high", prompt: "a.txt를 고쳐 주세요", timeoutSec: 30, env: { FAKE_AGY_LOG: log }, ...extra } as Parameters<typeof exec.run>[0]);

describe("Antigravity 실행기", () => {
  it("agy -p로 실행하고 결과·사용량·바뀐 파일을 돌려준다", async () => {
    const out = await run();
    expect(out).toMatchObject({ ok: true, engine: "antigravity", provider: "antigravity", summary: expect.stringContaining("gemini-3.1-pro-high"), costUsd: 0, sessionId: "c-1" });
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 40, cachedInputTokens: 40 });
    expect(out.changedFiles.map((f) => f.file)).toContain("agy-made.txt");
    const call = JSON.parse(readFileSync(log, "utf8").trim());
    expect(call.args).toEqual(["-p", "a.txt를 고쳐 주세요", "--output-format", "json", "--model", "gemini-3.1-pro-high", "--dangerously-skip-permissions"]);
  });

  it("읽기 전용이면 도구 승인을 하지 않는다", async () => {
    const out = await run({ readOnly: true });
    expect(out.ok).toBe(true);
    expect(out.changedFiles).toEqual([]);
    expect(agyArgs({ model: "m", prompt: "p", readOnly: true })).not.toContain("--dangerously-skip-permissions");
  });

  it("한도와 로그인 오류를 구분한다", async () => {
    process.env.FAKE_AGY_MODE = "quota";
    expect(await run()).toMatchObject({ ok: false, errorFamily: "provider_quota" });
    process.env.FAKE_AGY_MODE = "auth";
    expect(await run()).toMatchObject({ ok: false, errorFamily: "provider_auth" });
    expect(classifyError("Unknown model: x")).toBe("task_failed");
  });

  it("agy가 없으면 설치하라고 알린다", async () => {
    const missing = new AntigravityExecutor({ command: path.join(dir, "no-agy") });
    const out = await missing.run({ cwd: dir, model: "m", prompt: "p", timeoutSec: 10 } as Parameters<typeof exec.run>[0]);
    expect(out).toMatchObject({ ok: false, errorFamily: "spawn_failed" });
    expect(out.errorMessage).toContain("Antigravity CLI");
  });

  it("긴 지시문은 작업 폴더 밖 임시 파일로 넘기고 끝나면 지운다", async () => {
    const long = "가".repeat(30_000);
    const out = await run({ prompt: long });
    expect(out.ok).toBe(true);
    const call = JSON.parse(readFileSync(log, "utf8").trim());
    expect(call.prompt.length).toBeLessThan(500);
    expect(call.full).toBe(long);
    const file = call.prompt.match(/작업해 주세요: (.+)$/)[1];
    expect(file.startsWith(dir)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(promptArg("짧음").text).toBe("짧음");
  });
});
