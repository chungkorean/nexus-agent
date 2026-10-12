import { removeWorktree, type Worktree } from "@nexus/shared";

/** 같은 저장소에서 worktree 추가·삭제·합치기가 겹치면 git 잠금 파일이 충돌하므로 하나씩 한다. */
let gitQueue: Promise<unknown> = Promise.resolve();
export function serialGit<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(fn, fn);
  gitQueue = next.catch(() => undefined);
  return next;
}

/** 임시 작업 폴더를 정리한다. 정리 실패는 실행 결과에 영향을 주지 않고 로그만 남긴다. */
export async function cleanupWorktree(wt: Worktree, log: (line: string) => unknown): Promise<void> {
  try {
    const removed = await serialGit(() => removeWorktree(wt));
    if (!removed) await log(`임시 작업 폴더를 지우지 못해 남겨 뒀어요: ${wt.dir} (나중에 지워도 돼요)`);
  } catch (err) {
    await log(`임시 작업 폴더 정리 중 오류(무시): ${(err as Error).message}`);
  }
}
