// Paperclip에 Nexus 어댑터(nexus_dispatch)를 저절로 설치하고, Nexus를 새로 빌드하면 다시 불러오게 한다.
// Paperclip을 혼자 쓰는 PC(local_trusted)에서는 같은 PC의 요청을 관리자로 보므로 따로 로그인할 필요가 없다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ADAPTER_TYPE = "nexus_dispatch";

export interface AdapterSyncOptions {
  paperclipUrl: string;
  /** packages/paperclip-adapter 폴더 */
  adapterDir: string;
  stateDir: string;
  /** 지금 빌드의 커밋. 바뀌면 Paperclip에 다시 불러오라고 한다. */
  build: string | null;
  /** Paperclip이 늦게 켜질 수 있어 다시 해 보는 간격(밀리초). 기본 30초 */
  retryMs?: number;
  /** 다시 해 보는 횟수. 기본 40번(약 20분) */
  maxTries?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface AdapterSyncStatus {
  state: "waiting" | "installed" | "reloaded" | "ok" | "failed" | "skipped";
  message: string;
  at: string;
}

export interface AdapterSync {
  /** 한 번 맞춰 본다. 끝났으면(성공·포기) true */
  runOnce(): Promise<boolean>;
  start(): void;
  stop(): void;
  status(): AdapterSyncStatus;
}

interface Remembered {
  build: string | null;
}

export function createAdapterSync(o: AdapterSyncOptions): AdapterSync {
  const f = o.fetchImpl ?? fetch;
  const base = o.paperclipUrl.replace(/\/$/, "").replace("://localhost", "://127.0.0.1");
  const file = path.join(o.stateDir, "paperclip-adapter.json");
  const log = o.log ?? ((line: string) => console.log(`  ${line}`));
  let current: AdapterSyncStatus = { state: "waiting", message: "Paperclip이 켜지기를 기다리는 중이에요.", at: new Date().toISOString() };
  let timer: NodeJS.Timeout | null = null;
  let tries = 0;

  const set = (state: AdapterSyncStatus["state"], message: string) => {
    current = { state, message, at: new Date().toISOString() };
  };
  const remembered = (): Remembered => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Remembered;
    } catch {
      return { build: null };
    }
  };
  const remember = () => {
    try {
      mkdirSync(o.stateDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ build: o.build } satisfies Remembered));
    } catch {
      /* 못 남기면 다음에 한 번 더 불러올 뿐이다 */
    }
  };
  async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await f(base + p, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* 본문 없음 */
    }
    return { status: res.status, json };
  }

  async function runOnce(): Promise<boolean> {
    if (!existsSync(path.join(o.adapterDir, "dist", "server", "index.js"))) {
      set("skipped", "Nexus 어댑터가 아직 빌드되지 않았어요. 저장소 폴더에서 pnpm build를 해 주세요.");
      return true;
    }
    let list: { status: number; json: any };
    try {
      list = await call("GET", "/api/adapters");
    } catch {
      set("waiting", "Paperclip이 켜지기를 기다리는 중이에요.");
      return false;
    }
    if (list.status === 401 || list.status === 403) {
      set("failed", "Paperclip이 로그인을 요구해서 어댑터를 저절로 설치하지 못했어요. Paperclip 설정 › Adapters에서 직접 설치해 주세요.");
      return true;
    }
    if (list.status !== 200 || !Array.isArray(list.json)) {
      set("waiting", `Paperclip이 아직 준비되지 않았어요 (${list.status}).`);
      return false;
    }
    const found = list.json.find((a: { type?: string }) => a.type === ADAPTER_TYPE);
    try {
      if (!found) {
        const r = await call("POST", "/api/adapters/install", { packageName: o.adapterDir, isLocalPath: true });
        if (r.status >= 300) {
          set("failed", `Paperclip에 Nexus 어댑터를 설치하지 못했어요: ${r.json?.error ?? r.status}`);
          return r.status < 500;
        }
        remember();
        set("installed", "Paperclip에 Nexus 어댑터를 설치했어요. 에이전트를 만들 때 어댑터에서 nexus_dispatch를 고르세요.");
        log(current.message);
        return true;
      }
      if (o.build && remembered().build !== o.build) {
        const r = await call("POST", `/api/adapters/${ADAPTER_TYPE}/reload`);
        if (r.status >= 300) {
          set("failed", `Nexus 어댑터를 다시 불러오지 못했어요: ${r.json?.error ?? r.status}`);
          return r.status < 500;
        }
        remember();
        set("reloaded", "새로 빌드한 Nexus 어댑터를 Paperclip에 다시 불러왔어요.");
        log(current.message);
        return true;
      }
      set("ok", "Paperclip에 Nexus 어댑터가 설치되어 있어요.");
      return true;
    } catch (err) {
      set("waiting", `Paperclip과 연결이 끊겼어요: ${(err as Error).message}`);
      return false;
    }
  }

  const tick = async () => {
    timer = null;
    const done = await runOnce();
    tries++;
    if (!done && tries < (o.maxTries ?? 40)) timer = setTimeout(tick, o.retryMs ?? 30_000);
  };

  return {
    runOnce,
    start() {
      if (!timer) timer = setTimeout(tick, 0);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    status: () => current,
  };
}
