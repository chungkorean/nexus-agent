import { runProcess } from "./process.ts";
import type { ChangedFile } from "./types.ts";

/** 작업 폴더가 git 저장소가 아닐 수도 있다(엑셀 파싱, APK 분석 같은 작업). 그때는 null을 돌려준다. */
export async function gitSnapshot(cwd: string): Promise<Map<string, string> | null> {
  const res = await runProcess("git", ["status", "--porcelain=v1", "-uall"], { cwd, timeoutSec: 30 });
  if (res.spawnError || res.exitCode !== 0) return null;
  const map = new Map<string, string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    map.set(line.slice(3).trim(), line.slice(0, 2).trim());
  }
  return map;
}

/** 실행하면서 저절로 생기는 파일(파이썬 캐시, 테스트 캐시 등). 결과 보고와 커밋에서 뺀다. */
export const GENERATED_PATTERNS = ["**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", "**/.DS_Store", "**/Thumbs.db"];

export function isGeneratedFile(file: string): boolean {
  const f = file.replace(/\\/g, "/").replace(/^"|"$/g, "");
  return /(^|\/)(__pycache__|\.pytest_cache)(\/|$)/.test(f) || /\.pyc$/.test(f) || /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(f);
}

/** git add에 붙여 저절로 생기는 파일을 빼는 pathspec */
export const EXCLUDE_GENERATED = GENERATED_PATTERNS.map((g) => `:(exclude,glob)${g}`);

/** 실행 전후의 git status를 비교해 이번 실행에서 상태가 바뀐 파일만 고른다. */
export function diffSnapshots(before: Map<string, string> | null, after: Map<string, string> | null): ChangedFile[] {
  if (!after) return [];
  const changed: ChangedFile[] = [];
  for (const [file, status] of after) {
    if (before?.get(file) !== status && !isGeneratedFile(file)) changed.push({ file, status });
  }
  return changed;
}

/**
 * 작업 폴더에서 바로 고친 변경을 검토용 diff로 만든다.
 * 추적 중인 파일은 마지막 커밋과 비교하고, 새 파일은 내용을 통째로 붙인다(큰 파일·바이너리는 뺌).
 */
export async function workingDiff(cwd: string, files: ChangedFile[]): Promise<{ stat: string; diff: string }> {
  const { readFileSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const tracked = files.filter((f) => f.status !== "??").map((f) => f.file);
  const added = files.filter((f) => f.status === "??").map((f) => f.file);
  let diff = "";
  if (tracked.length) {
    const res = await runProcess("git", ["diff", "--no-color", "HEAD", "--", ...tracked], { cwd, timeoutSec: 60 });
    if (res.exitCode === 0) diff += res.stdout;
  }
  for (const f of added) {
    try {
      const full = path.join(cwd, f);
      if (statSync(full).size > 200_000) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes("\u0000")) continue;
      const body = text.split(/\r?\n/).map((l) => `+${l}`).join("\n");
      diff += `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${body}\n`;
    } catch {
      /* 읽지 못한 파일은 뺀다 */
    }
  }
  const stat = files.map((f) => `${f.status === "??" ? "새 파일" : "수정"}: ${f.file}`).join("\n");
  return { stat, diff: diff.trim() };
}
