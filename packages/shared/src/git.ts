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

/** 실행 전후의 git status를 비교해 이번 실행에서 상태가 바뀐 파일만 고른다. */
export function diffSnapshots(before: Map<string, string> | null, after: Map<string, string> | null): ChangedFile[] {
  if (!after) return [];
  const changed: ChangedFile[] = [];
  for (const [file, status] of after) {
    if (before?.get(file) !== status) changed.push({ file, status });
  }
  return changed;
}
