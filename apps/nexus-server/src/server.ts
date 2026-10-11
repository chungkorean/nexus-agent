// 쉬운 설정 화면용 로컬 웹 서버. 127.0.0.1에서만 열고, 사용자 설정 폴더의 YAML을 고친다.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccountState, ConfigError, type Account, type Engine, type NexusConfig } from "@nexus/shared";
import { buildLoginCommand, defaultLauncher, type LaunchResult, type LoginCommand } from "./login.ts";
import {
  addAccountToDoc,
  applyChanges,
  check,
  createBackup,
  ensureConfigFiles,
  LIMITS,
  listBackups,
  loadFiles,
  removeAccountFromDoc,
  rollback,
  TASK_TYPE_NAMES,
  writeFiles,
  type LoadedFiles,
} from "./store.ts";

export type { LaunchResult, LoginCommand } from "./login.ts";
export type { SettingsChanges } from "./store.ts";

export interface SettingsServerOptions {
  configDir: string;
  fallbackDir?: string;
  stateDir: string;
  accountsDir: string;
  launcher?: (cmd: LoginCommand) => Promise<LaunchResult>;
  /** 기본 3200. 테스트는 0 */
  port?: number;
  /** 정적 파일 폴더. 생략하면 이 파일 옆의 public 또는 ../public */
  publicDir?: string;
}

export interface SettingsServer {
  listen(): Promise<string>;
  close(): Promise<void>;
  readonly server: http.Server;
}

const BODY_LIMIT = 256 * 1024;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const ENGINES: Engine[] = ["claude-code", "opencode"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems?: string[],
  ) {
    super(message);
  }
}

function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "public"), path.join(here, "..", "public")]) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return path.join(here, "public");
}

/** 로그인해 둔 흔적이 있는지. Claude Code는 .credentials.json, OpenCode는 opencode/auth.json */
function hasLogin(account: Account): boolean {
  if (account.provider === "ollama") return true;
  if (account.engine === "claude-code") return existsSync(path.join(account.dir, ".credentials.json"));
  return existsSync(path.join(account.dir, "opencode", "auth.json"));
}

export function createSettingsServer(opts: SettingsServerOptions): SettingsServer {
  const publicDir = path.resolve(opts.publicDir ?? findPublicDir());
  const launcher = opts.launcher ?? defaultLauncher;
  let allowedHosts = new Set<string>();

  ensureConfigFiles(opts.configDir, opts.fallbackDir);

  /** 지금 설정을 읽고 검사한다. 문제가 있으면 화면에 보여 줄 오류로 바꾼다. */
  function loadValid(): { loaded: LoadedFiles; config: NexusConfig } {
    let loaded: LoadedFiles;
    try {
      loaded = loadFiles(opts.configDir);
    } catch (err) {
      if (err instanceof ConfigError) throw new HttpError(500, err.message);
      throw err;
    }
    const result = check(loaded, opts.accountsDir);
    if (!result.config) {
      throw new HttpError(500, "지금 설정 파일에 문제가 있어요. '되돌리기'를 눌러 이전 설정으로 돌아가 보세요.", result.problems);
    }
    return { loaded, config: result.config };
  }

  function state() {
    const { config } = loadValid();
    const cooldowns = new AccountState(opts.stateDir).all();
    const aliasLabel = (name: string) => config.aliases[name]?.label ?? name;
    return {
      configDir: opts.configDir,
      canRollback: listBackups(opts.configDir).length > 0,
      aliases: Object.entries(config.aliases).map(([name, a]) => ({
        name,
        label: a.label ?? name,
        engine: a.engine,
        model: a.model,
        accounts: a.accounts ?? [],
      })),
      accounts: Object.values(config.accounts).map((acc) => ({
        id: acc.id,
        engine: acc.engine,
        provider: acc.provider,
        label: acc.label,
        dir: acc.dir,
        loggedIn: hasLogin(acc),
        cooldown: cooldowns[acc.id] ?? null,
        usedBy: Object.entries(config.aliases)
          .filter(([, a]) => a.accounts?.includes(acc.id))
          .map(([name]) => aliasLabel(name)),
      })),
      taskTypes: TASK_TYPE_NAMES.map(([id, name]) => ({ id, name, chain: config.routing.taskTypes[id] ?? [] })),
      routing: {
        defaultWhenUnsure: config.routing.defaultWhenUnsure,
        preferLocal: config.routing.preferLocal,
        lightTaskTypes: config.routing.lightTaskTypes,
        highRiskAlias: config.routing.highRiskAlias,
        maxFallbacks: config.routing.maxFallbacks,
        planning: config.routing.planning,
      },
      limits: LIMITS,
    };
  }

  function dryRun(body: unknown) {
    const { loaded, config } = loadValid();
    const { sentences, problems, dirty } = applyChanges(loaded, config, body);
    if (problems.length) return { loaded, sentences, problems, dirty };
    const result = check(loaded, opts.accountsDir);
    return { loaded, sentences, problems: result.problems, dirty };
  }

  /** 백업을 남기고 고친 파일만 쓴다. */
  function commit(loaded: LoadedFiles, dirty: Iterable<"models" | "routing" | "accounts">): void {
    createBackup(opts.configDir);
    writeFiles(opts.configDir, loaded, dirty);
  }

  function findAccount(config: NexusConfig, body: Record<string, unknown>): Account {
    const id = typeof body.id === "string" ? body.id : "";
    const account = config.accounts[id];
    if (!account) throw new HttpError(404, "그 계정을 찾지 못했어요. 화면을 새로 고쳐 주세요.");
    return account;
  }

  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
    "/api/preview": (body) => {
      const { sentences, problems } = dryRun(body);
      return { ok: problems.length === 0, sentences, problems };
    },

    "/api/save": (body) => {
      const { loaded, sentences, problems, dirty } = dryRun(body);
      if (problems.length) throw new HttpError(400, "설정에 문제가 있어 저장하지 않았어요.", problems);
      if (dirty.size === 0) return { ok: true, sentences: [], message: "바뀐 내용이 없어요." };
      commit(loaded, dirty);
      return { ok: true, sentences, message: "저장했어요. 다음 작업부터 적용돼요." };
    },

    "/api/rollback": () => {
      const result = rollback(opts.configDir, opts.accountsDir);
      if (!result.ok) throw new HttpError(result.status, result.error, result.problems);
      return { ok: true, message: "이전 설정으로 되돌렸어요. 다음 작업부터 적용돼요." };
    },

    "/api/accounts": (body) => {
      const { loaded, config } = loadValid();
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const engine = body.engine as Engine;
      if (!ACCOUNT_ID.test(id)) throw new HttpError(400, "계정 이름은 영문, 숫자, -, _ 로 40자 안에서 지어 주세요. (예: claude-main)");
      if (!ENGINES.includes(engine)) throw new HttpError(400, "계정 종류를 골라 주세요.");
      if (Object.keys(config.accounts).some((k) => k.toLowerCase() === id.toLowerCase())) {
        throw new HttpError(409, "같은 이름의 계정이 이미 있어요. 다른 이름을 지어 주세요.");
      }
      const provider = typeof body.provider === "string" && /^[a-z0-9._-]{1,40}$/i.test(body.provider.trim()) ? body.provider.trim() : engine === "claude-code" ? "anthropic" : "opencode";
      const labelRaw = typeof body.label === "string" ? body.label.trim() : "";
      if (labelRaw.length > 80) throw new HttpError(400, "보여 줄 이름은 80자 안으로 적어 주세요.");
      addAccountToDoc(loaded.docs.accounts, id, { engine, provider, label: labelRaw || id });
      const result = check(loaded, opts.accountsDir);
      if (!result.config) throw new HttpError(400, "계정을 추가하지 못했어요.", result.problems);
      commit(loaded, ["accounts"]);
      const account = result.config.accounts[id]!;
      mkdirSync(account.dir, { recursive: true });
      return { ok: true, message: "계정을 추가했어요. 이제 '로그인 창 열기'를 눌러 로그인해 주세요." };
    },

    "/api/accounts/remove": (body) => {
      const { loaded, config } = loadValid();
      const account = findAccount(config, body);
      const users = Object.entries(config.aliases).filter(([, a]) => a.accounts?.includes(account.id));
      if (users.length) {
        const names = users.map(([name, a]) => a.label ?? name).join(", ");
        throw new HttpError(409, `이 계정을 쓰는 AI 모델이 있어요 (${names}). 먼저 'AI 모델' 칸에서 이 계정의 체크를 풀고 저장해 주세요.`);
      }
      removeAccountFromDoc(loaded.docs.accounts, account.id);
      const result = check(loaded, opts.accountsDir);
      if (!result.config) throw new HttpError(400, "계정을 지우지 못했어요.", result.problems);
      commit(loaded, ["accounts"]);
      new AccountState(opts.stateDir).clear(account.id);
      return { ok: true, message: `'${account.label}' 계정을 목록에서 지웠어요. 로그인 정보 폴더는 그대로 남아 있어요.` };
    },

    "/api/accounts/login": async (body) => {
      const { config } = loadValid();
      const account = findAccount(config, body);
      mkdirSync(account.dir, { recursive: true });
      const cmd = buildLoginCommand(account);
      const result = await launcher(cmd);
      if (result.launched) {
        const message =
          account.engine === "claude-code"
            ? "새 창이 열렸어요. 창의 안내를 따라 주세요. 입력 칸이 보이면 /login 을 입력하고 Enter를 누른 뒤, 열리는 브라우저에서 로그인해 주세요. 다 끝나면 창을 닫아도 돼요."
            : "새 창이 열렸어요. 로그인할 서비스를 화살표 키로 고르고 Enter를 누른 뒤, 안내대로 로그인해 주세요. 다 끝나면 창을 닫아도 돼요.";
        return { ok: true, launched: true, message };
      }
      return {
        ok: true,
        launched: false,
        commandText: result.commandText,
        message:
          account.engine === "claude-code"
            ? "로그인 창을 자동으로 열지 못했어요. 아래 명령을 터미널에 붙여 넣어 실행한 뒤, /login 을 입력해 로그인해 주세요."
            : "로그인 창을 자동으로 열지 못했어요. 아래 명령을 터미널에 붙여 넣어 실행하고 안내대로 로그인해 주세요.",
      };
    },

    "/api/accounts/reset": (body) => {
      const { config } = loadValid();
      const account = findAccount(config, body);
      new AccountState(opts.stateDir).clear(account.id);
      return { ok: true, message: `'${account.label}' 계정을 다시 쓸 수 있게 했어요.` };
    },
  };

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > BODY_LIMIT) {
        reject(new HttpError(413, "보낸 내용이 너무 커요."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on("data", (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > BODY_LIMIT) {
          failed = true;
          reject(new HttpError(413, "보낸 내용이 너무 커요."));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (failed) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpError(400, "보낸 내용을 이해하지 못했어요. 화면을 새로 고쳐 주세요."));
        }
      });
      req.on("error", reject);
    });
  }

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return send(res, 400, { ok: false, error: "주소가 올바르지 않아요." });
    }
    if (rel.includes("\0")) return send(res, 400, { ok: false, error: "주소가 올바르지 않아요." });
    const file = path.resolve(publicDir, "." + path.posix.normalize(rel.replace(/\\/g, "/")));
    if (!file.startsWith(publicDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      return send(res, 404, { ok: false, error: "찾는 페이지가 없어요." });
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(readFileSync(file));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS 리바인딩 막기: 주소창에 127.0.0.1 또는 localhost로 연 요청만 받는다.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 403, { ok: false, error: "이 주소로는 열 수 없어요. 127.0.0.1 주소로 열어 주세요." });
    const origin = req.headers.origin;
    if (origin && ![...allowedHosts].some((h) => origin.toLowerCase() === `http://${h}`)) {
      return send(res, 403, { ok: false, error: "다른 사이트에서 보낸 요청은 받지 않아요." });
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/state") {
        if (req.method !== "GET") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        return send(res, 200, { ok: true, ...state() });
      }
      const route = routes[pathname];
      if (!route) return send(res, 404, { ok: false, error: "찾는 기능이 없어요." });
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
      // CSRF 막기: 다른 사이트의 폼은 이 머리글과 JSON 형식을 보낼 수 없다.
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (req.headers["x-nexus"] !== "1" || !contentType.startsWith("application/json")) {
        return send(res, 403, { ok: false, error: "설정 화면에서 보낸 요청만 받아요. 화면을 새로 고쳐 주세요." });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "보낸 내용을 이해하지 못했어요.");
      return send(res, 200, await route(body as Record<string, unknown>));
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
    serveStatic(pathname, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message, problems: err.problems ?? [] });
      if (err instanceof ConfigError) return send(res, 400, { ok: false, error: "설정에 문제가 있어요.", problems: err.message.split("\n") });
      console.error(err);
      send(res, 500, { ok: false, error: "알 수 없는 문제가 생겼어요. 설정 화면을 껐다가 다시 켜 주세요." });
    });
  });

  return {
    server,
    listen() {
      return new Promise<string>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(opts.port ?? 3200, "127.0.0.1", () => {
          server.off("error", onError);
          const { port } = server.address() as AddressInfo;
          allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
          resolve(`http://127.0.0.1:${port}/`);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
