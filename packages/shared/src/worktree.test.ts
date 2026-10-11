import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeIntoWorkdir } from "./worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function repoWithBranches(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-merge-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  for (const [branch, text] of [["one", "one\n"], ["two", "two\n"]] as const) {
    git(dir, "checkout", "-qb", branch, "main");
    writeFileSync(path.join(dir, "a.txt"), text);
    git(dir, "commit", "-qam", branch);
  }
  git(dir, "checkout", "-q", "main");
  return dir;
}

describe("mergeIntoWorkdir", () => {
  it("충돌하면 합치기 전 상태로 되돌린다", async () => {
    const dir = repoWithBranches();
    const before = git(dir, "rev-parse", "HEAD");
    const res = await mergeIntoWorkdir(dir, ["one", "two"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("충돌");
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("base\n");
  });

  it("충돌이 없으면 현재 브랜치에 합친다", async () => {
    const dir = repoWithBranches();
    const res = await mergeIntoWorkdir(dir, ["one"]);
    expect(res).toMatchObject({ ok: true, branch: "main" });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
  });
});
