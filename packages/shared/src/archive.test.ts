import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveMediaPath, archiveRun, listArchive, readArchive, removeArchive, resultStatus } from "./archive.ts";

let tmp: string;
let stateDir: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-archive-"));
  stateDir = path.join(tmp, "state");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("작업 기록 보관함", () => {
  it("결과와 작업 폴더에서 만든 이미지·오디오를 남기고, 목록·읽기·지우기를 한다", async () => {
    const work = path.join(tmp, "work");
    mkdirSync(path.join(work, "art"), { recursive: true });
    writeFileSync(path.join(work, "art", "hero.png"), PNG);
    writeFileSync(path.join(work, "theme.mp3"), "ID3");
    writeFileSync(path.join(work, "main.py"), "print(1)");
    writeFileSync(path.join(tmp, "secret.png"), PNG);

    const rec = await archiveRun(stateDir, {
      issue: { id: "i1", identifier: "NEX-7", title: "주인공 콘셉트", description: "누아르 분위기", companyId: "co-1" },
      body: "### Nexus 실행 결과: 완료\n\n- 실행: OpenCode\n\n그림 두 장을 만들었어요.",
      cwd: work,
      models: ["google/gemini-3-pro", "google/gemini-3-pro"],
      costUsd: 0.12,
      media: [{ root: work, files: ["art/hero.png", "theme.mp3", "main.py", "../secret.png", "missing.png"] }],
      now: new Date(2026, 9, 12, 9, 30, 5),
    });
    expect(rec.id).toBe("20261012-093005-NEX-7");
    expect(rec.status).toBe("완료");
    expect(rec.models).toEqual(["google/gemini-3-pro"]);
    expect(rec.media.map((m) => [m.name, m.kind])).toEqual([["hero.png", "image"], ["theme.mp3", "audio"]]);

    const list = listArchive(stateDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.preview).toBe("그림 두 장을 만들었어요.");
    expect(listArchive(stateDir, { q: "gemini" })).toHaveLength(1);
    expect(listArchive(stateDir, { q: "없는말" })).toHaveLength(0);

    const read = readArchive(stateDir, rec.id)!;
    expect(read.issue).toContain("누아르 분위기");
    expect(readFileSync(archiveMediaPath(stateDir, rec.id, "hero.png")!)).toEqual(PNG);
    expect(archiveMediaPath(stateDir, rec.id, "../run.json")).toBeNull();
    expect(readArchive(stateDir, "../state")).toBeNull();

    expect(removeArchive(stateDir, rec.id)).toBe(true);
    expect(listArchive(stateDir)).toEqual([]);
  });

  it("git 브랜치에서 바뀐 미디어를 꺼내 온다", async () => {
    const repo = path.join(tmp, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-qb", "nexus/NEX-8/result");
    mkdirSync(path.join(repo, "img"));
    writeFileSync(path.join(repo, "img", "poster.png"), PNG);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "poster");
    git(repo, "checkout", "-q", "main");

    const rec = await archiveRun(stateDir, {
      issue: { id: "i8", identifier: "NEX-8", title: "포스터" },
      body: "### Nexus 작업 결과: 확인 필요",
      media: [{ root: repo, ref: "nexus/NEX-8/result", base }],
    });
    expect(rec.status).toBe("확인 필요");
    expect(rec.media).toMatchObject([{ name: "poster.png", source: "img/poster.png", kind: "image" }]);
    expect(readFileSync(archiveMediaPath(stateDir, rec.id, "poster.png")!)).toEqual(PNG);
  });

  it("결과 제목에서 상태를 읽는다", () => {
    expect(resultStatus("### Nexus가 작업을 시작하지 못했어요\n\n...")).toBe("실패");
    expect(resultStatus("### Nexus 실행 결과: 실패")).toBe("실패");
  });
});
