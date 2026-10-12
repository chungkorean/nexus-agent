/** 같은 저장소에서 worktree 추가·삭제·합치기가 겹치면 git 잠금 파일이 충돌하므로 하나씩 한다. */
let gitQueue: Promise<unknown> = Promise.resolve();
export function serialGit<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(fn, fn);
  gitQueue = next.catch(() => undefined);
  return next;
}
