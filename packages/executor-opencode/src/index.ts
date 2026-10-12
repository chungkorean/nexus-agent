import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  diffSnapshots,
  gitSnapshot,
  killTree,
  stopTree,
  startProcess,
  type ChangedFile,
  type CommandSpec,
  type ErrorFamily,
  type Executor,
  type RunOutcome,
  type RunRequest,
} from "@nexus/shared";

export interface OpenCodeExecutorOptions {
  /** 기본값 "opencode". 테스트에서는 ["node", "fake-opencode.mjs"]처럼 넘긴다. */
  command?: CommandSpec;
  /** opencode serve가 주소를 알릴 때까지 기다리는 시간 */
  startupTimeoutSec?: number;
}

/**
 * 작업마다 opencode serve를 하나 띄워 세션을 만들고, 작업에 맞는 모델로 지시를 보낸다.
 * opencode run과 달리 지시마다 모델을 고를 수 있고, 끝나면 세션 diff로 바뀐 파일을 가져온다.
 */
export class OpenCodeExecutor implements Executor {
  readonly engine = "opencode" as const;
  constructor(private readonly opts: OpenCodeExecutorOptions = {}) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const slash = req.model.indexOf("/");
    if (slash <= 0) {
      return fail(req.model, `OpenCode 모델은 provider/model 형식이어야 해요: ${req.model}`, "task_failed");
    }
    const providerID = req.model.slice(0, slash);
    const modelID = req.model.slice(slash + 1);
    const password = randomBytes(18).toString("base64url");

    let server: { child: ChildProcess; url: string };
    try {
      server = await startServer(this.opts.command ?? "opencode", {
        cwd: req.cwd,
        env: {
          ...req.env,
          ...(req.accountDir ? { XDG_DATA_HOME: req.accountDir } : {}),
          OPENCODE_SERVER_PASSWORD: password,
          // 무인 실행이므로 승인 질문 없이 진행한다. 작업 폴더 격리는 호출하는 쪽이 책임진다.
          // 읽기 전용(작업 분해)일 때는 파일 수정과 터미널을 막는다.
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: req.readOnly ? { edit: "deny", bash: "deny", webfetch: "allow" } : { edit: "allow", bash: "allow", webfetch: "allow" },
          }),
        },
        timeoutSec: this.opts.startupTimeoutSec ?? 30,
        onLog: req.onLog,
      });
    } catch (err) {
      return fail(req.model, `opencode serve를 시작하지 못했어요: ${(err as Error).message}`, "spawn_failed", providerID);
    }

    const api = new OpenCodeApi(server.url, password, req.cwd);
    const before = await gitSnapshot(req.cwd);
    let sessionId: string | null = null;
    const timeout = AbortSignal.timeout(Math.max(1, req.timeoutSec) * 1000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    try {
      const session = await api.post<{ id: string }>("/session", { title: req.prompt.split("\n")[0]?.slice(0, 80) });
      sessionId = session.id;
      await req.onLog?.("stdout", `[nexus] OpenCode 세션 ${session.id} 시작, 모델 ${req.model}\n`);

      let reply: PromptReply;
      try {
        reply = await api.post<PromptReply>(
          `/session/${session.id}/message`,
          { model: { providerID, modelID }, ...(req.readOnly ? { agent: "plan" } : {}), parts: [{ type: "text", text: req.prompt }] },
          signal,
        );
      } catch (err) {
        if (signal.aborted) {
          await api.post(`/session/${session.id}/abort`, {}).catch(() => undefined);
          const timedOut = timeout.aborted;
          return { ...fail(req.model, timedOut ? "시간 초과로 중단했어요" : "취소됐어요", "timeout", providerID), sessionId, timedOut };
        }
        throw err;
      }

      const summary = reply.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();
      const changedFiles = await this.changedFiles(api, session.id, before, req.cwd);
      const info = reply.info;
      const usage = info.tokens
        ? { inputTokens: info.tokens.input ?? 0, outputTokens: info.tokens.output ?? 0, cachedInputTokens: info.tokens.cache?.read ?? 0 }
        : undefined;

      if (info.error) {
        const { family, message } = mapError(info.error);
        return { ...fail(req.model, message, family, providerID), summary, usage, costUsd: info.cost ?? null, sessionId, changedFiles };
      }
      return {
        ok: true,
        engine: "opencode",
        model: req.model,
        provider: providerID,
        summary: summary || "(응답 없음)",
        usage,
        costUsd: info.cost ?? null,
        sessionId,
        changedFiles,
      };
    } catch (err) {
      return { ...fail(req.model, `OpenCode 호출 실패: ${(err as Error).message}`, "provider_unavailable", providerID), sessionId };
    } finally {
      await stopTree(server.child);
    }
  }

  private async changedFiles(api: OpenCodeApi, sessionId: string, before: Map<string, string> | null, cwd: string): Promise<ChangedFile[]> {
    try {
      const diffs = await api.get<Array<{ file: string; additions?: number; deletions?: number }>>(`/session/${sessionId}/diff`);
      if (Array.isArray(diffs) && diffs.length) {
        return diffs.map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions }));
      }
    } catch {
      /* 아래 git 비교로 대신한다 */
    }
    return diffSnapshots(before, await gitSnapshot(cwd));
  }
}

interface PromptReply {
  info: {
    cost?: number;
    tokens?: { input?: number; output?: number; cache?: { read?: number } };
    error?: { name?: string; data?: { message?: string; statusCode?: number } };
  };
  parts: Array<{ type: string; text?: string }>;
}

function mapError(error: NonNullable<PromptReply["info"]["error"]>): { family: ErrorFamily; message: string } {
  const message = error.data?.message ?? error.name ?? "알 수 없는 오류";
  if (error.name === "ProviderAuthError") return { family: "provider_auth", message: `로그인이 필요하거나 만료됐어요: ${message}` };
  if (error.data?.statusCode === 429 || /quota|rate.?limit|limit exceeded|overloaded/i.test(message)) {
    return { family: "provider_quota", message: `사용 한도에 걸렸어요: ${message}` };
  }
  if (error.name === "MessageAbortedError") return { family: "timeout", message };
  return { family: "task_failed", message };
}

function fail(model: string, message: string, family: ErrorFamily, provider?: string): RunOutcome {
  return { ok: false, engine: "opencode", model, provider, summary: "", changedFiles: [], errorMessage: message, errorFamily: family };
}

class OpenCodeApi {
  private readonly auth: string;
  constructor(
    private readonly baseUrl: string,
    password: string,
    private readonly directory: string,
  ) {
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  }

  private url(p: string): string {
    const u = new URL(p, this.baseUrl);
    u.searchParams.set("directory", this.directory);
    return u.toString();
  }

  async get<T>(p: string): Promise<T> {
    const res = await fetch(this.url(p), { headers: { authorization: this.auth } });
    if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
    return (await res.json()) as T;
  }

  async post<T>(p: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(p), {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`POST ${p} → ${res.status} ${await res.text().catch(() => "")}`.trim());
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(
  command: CommandSpec,
  opts: { cwd: string; env: Record<string, string>; timeoutSec: number; onLog?: RunRequest["onLog"] },
): Promise<{ child: ChildProcess; url: string }> {
  const port = await freePort();
  const child = startProcess(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: opts.cwd, env: opts.env });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`${opts.timeoutSec}초 안에 서버 주소가 나오지 않았어요. 출력: ${output.slice(-500)}`));
    }, opts.timeoutSec * 1000);
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      void opts.onLog?.(stream, text);
      output += text;
      const m = output.match(/listening on\s+(https?:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1]!.replace(/\/$/, "") });
      }
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode serve가 종료됐어요 (코드 ${code}). 출력: ${output.slice(-500)}`));
    });
  });
}
