import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess, type CommandSpec } from "@nexus/shared";

export interface GithubResult {
  pushed: boolean;
  remote: string;
  remoteUrl?: string;
  error?: string;
  prUrl?: string;
  prError?: string;
}

/** 원격 저장소 프롬프트에서 멈추지 않게 한다. Windows의 Git Credential Manager 창은 그대로 뜬다. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-6).join(" ").slice(0, 400);
}

/** 결과 브랜치를 원격 저장소에 올리고, 원하면 초안 풀 리퀘스트를 만든다. 실패해도 실행 결과는 그대로 둔다. */
export async function publishToGithub(
  repoRoot: string,
  branch: string,
  opts: { remote: string; pullRequest: boolean; title: string; body: string; ghCommand: CommandSpec; signal?: AbortSignal },
): Promise<GithubResult> {
  const result: GithubResult = { pushed: false, remote: opts.remote };
  const url = await runProcess("git", ["remote", "get-url", opts.remote], { cwd: repoRoot, timeoutSec: 30 });
  if (url.exitCode !== 0) {
    result.error = `작업 폴더에 연결된 원격 저장소가 없어요 (이름: ${opts.remote}). GitHub 저장소를 연결해 주세요 (git remote add ${opts.remote} <주소>).`;
    return result;
  }
  result.remoteUrl = url.stdout.trim();
  const push = await runProcess("git", ["push", "-u", opts.remote, `${branch}:${branch}`], { cwd: repoRoot, timeoutSec: 300, signal: opts.signal, env: NO_PROMPT });
  if (push.spawnError || push.exitCode !== 0) {
    result.error = `브랜치를 올리지 못했어요: ${tail(push.spawnError?.message ?? (push.stderr || push.stdout))}`;
    return result;
  }
  result.pushed = true;
  if (!opts.pullRequest) return result;

  const head = await runProcess("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repoRoot, timeoutSec: 30 });
  const base = head.exitCode === 0 ? head.stdout.trim() : "";
  if (!base) {
    result.prError = "작업 폴더가 특정 브랜치에 있지 않아 풀 리퀘스트의 대상 브랜치를 정하지 못했어요.";
    return result;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "nexus-pr-"));
  const bodyFile = path.join(dir, "body.md");
  writeFileSync(bodyFile, opts.body);
  try {
    const pr = await runProcess(
      opts.ghCommand,
      ["pr", "create", "--draft", "--base", base, "--head", branch, "--title", opts.title, "--body-file", bodyFile],
      { cwd: repoRoot, timeoutSec: 120, signal: opts.signal, env: { GH_PROMPT_DISABLED: "1" } },
    );
    if (pr.spawnError) result.prError = "GitHub CLI(gh)를 찾지 못했어요. https://cli.github.com 에서 설치하고 `gh auth login`을 해 주세요.";
    else if (pr.exitCode !== 0) {
      const err = tail(pr.stderr || pr.stdout);
      result.prError = /auth login|not logged/i.test(err) ? "GitHub CLI에 로그인되어 있지 않아요. `gh auth login`을 해 주세요." : `풀 리퀘스트를 만들지 못했어요: ${err}`;
    } else result.prUrl = pr.stdout.trim().split(/\r?\n/).find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? pr.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

export function githubLines(g: GithubResult, branch: string): string[] {
  const lines = ["", "#### GitHub"];
  if (!g.pushed) {
    lines.push(`- 올리지 못했어요. ${g.error ?? ""}`.trim());
    return lines;
  }
  lines.push(`- \`${branch}\` 브랜치를 ${g.remote}${g.remoteUrl ? ` (${g.remoteUrl})` : ""}에 올렸어요.`);
  if (g.prUrl) lines.push(`- 초안 풀 리퀘스트: ${g.prUrl}`);
  else if (g.prError) lines.push(`- ${g.prError}`);
  return lines;
}
