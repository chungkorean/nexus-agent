import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runProcess } from "./process.ts";

/** Nexus가 만드는 커밋의 작성자. 사용자의 git 설정이 없어도 커밋할 수 있게 한다. */
const IDENTITY = ["-c", "user.name=Nexus", "-c", "user.email=nexus@localhost", "-c", "commit.gpgsign=false"];

export class GitError extends Error {}

async function git(cwd: string, args: string[], timeoutSec = 120): Promise<string> {
  const res = await runProcess("git", [...IDENTITY, ...args], { cwd, timeoutSec });
  if (res.spawnError) throw new GitError(`git을 실행하지 못했어요: ${res.spawnError.message}`);
  if (res.exitCode !== 0) throw new GitError(`git ${args[0]} 실패: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
  return res.stdout.trim();
}

/** 저장소 최상위 폴더와 현재 커밋. git 저장소가 아니거나 커밋이 하나도 없으면 null */
export async function repoInfo(cwd: string): Promise<{ root: string; head: string; dirty: boolean } | null> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const status = await git(cwd, ["status", "--porcelain"]);
    return { root: path.resolve(root), head, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

/** 브랜치 이름에 쓸 수 없는 글자를 바꾼다. */
export function safeRef(part: string): string {
  const s = part
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\.lock$/i, "");
  return s.slice(0, 60) || "task";
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** 이미 있는 브랜치를 덮어쓰지 않도록 -2, -3을 붙인다. */
export async function uniqueBranch(repo: string, wanted: string): Promise<string> {
  if (!(await branchExists(repo, wanted))) return wanted;
  for (let i = 2; i < 100; i++) {
    if (!(await branchExists(repo, `${wanted}-${i}`))) return `${wanted}-${i}`;
  }
  return `${wanted}-${Date.now()}`;
}

export interface Worktree {
  repo: string;
  dir: string;
  branch: string;
  base: string;
}

/** base 커밋에서 새 브랜치로 worktree를 만든다. */
export async function addWorktree(repo: string, dir: string, branch: string, base: string): Promise<Worktree> {
  mkdirSync(path.dirname(dir), { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  await git(repo, ["worktree", "add", "-b", branch, dir, base]);
  return { repo, dir, branch, base };
}

/** 앞선 하위 작업의 브랜치를 합친다. 충돌하면 되돌리고 충돌 파일을 알려 준다. */
export async function mergeInto(wt: Worktree, branches: string[]): Promise<{ ok: true } | { ok: false; branch: string; message: string }> {
  for (const b of branches) {
    try {
      await git(wt.dir, ["merge", "--no-edit", "--no-ff", b]);
    } catch (err) {
      const conflicts = await git(wt.dir, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await git(wt.dir, ["merge", "--abort"]).catch(() => undefined);
      return { ok: false, branch: b, message: conflicts ? `충돌 파일: ${conflicts.split("\n").join(", ")}` : (err as Error).message };
    }
  }
  return { ok: true };
}

/** worktree의 모든 변경을 커밋한다. 바뀐 것이 없으면 null */
export async function commitAll(wt: Worktree, message: string): Promise<string | null> {
  await git(wt.dir, ["add", "-A"]);
  const staged = await git(wt.dir, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  await git(wt.dir, ["commit", "-q", "--no-verify", "-m", message]);
  return git(wt.dir, ["rev-parse", "HEAD"]);
}

/** worktree 폴더만 지우고 브랜치는 남긴다. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.repo, ["worktree", "remove", "--force", wt.dir]).catch(() => rmSync(wt.dir, { recursive: true, force: true }));
  await git(wt.repo, ["worktree", "prune"]).catch(() => undefined);
}

export type WorkdirMergeResult = { ok: true; branch: string; head: string } | { ok: false; reason: string };

/**
 * 하위 작업 브랜치들을 사용자 작업 폴더의 현재 브랜치에 합친다.
 * 커밋하지 않은 변경이 있거나 브랜치가 없는(detached) 상태면 건드리지 않는다.
 * 하나라도 충돌하면 합치기 전 상태로 되돌린다.
 */
export async function mergeIntoWorkdir(repo: string, branches: string[]): Promise<WorkdirMergeResult> {
  let current: string;
  try {
    current = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return { ok: false, reason: "작업 폴더가 특정 브랜치에 있지 않아요(detached HEAD)." };
  }
  const dirty = await git(repo, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "?");
  if (dirty) return { ok: false, reason: "작업 폴더에 커밋하지 않은 변경이 있어요." };
  const before = await git(repo, ["rev-parse", "HEAD"]);
  for (const b of branches) {
    try {
      await git(repo, ["merge", "--no-edit", b]);
    } catch (err) {
      const conflicts = await git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await git(repo, ["merge", "--abort"]).catch(() => undefined);
      await git(repo, ["reset", "-q", "--hard", before]).catch(() => undefined);
      return { ok: false, reason: conflicts ? `${b}를 합치다 충돌했어요 (${conflicts.split("\n").join(", ")}).` : `${b}를 합치지 못했어요: ${(err as Error).message}` };
    }
  }
  return { ok: true, branch: current, head: await git(repo, ["rev-parse", "HEAD"]) };
}
