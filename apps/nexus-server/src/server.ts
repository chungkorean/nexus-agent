// 쉬운 설정 화면용 로컬 웹 서버. 127.0.0.1에서만 열고, 사용자 설정 폴더의 YAML을 고친다.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PaperclipClient } from "@nexus/paperclip-client";
import {
  AccountState,
  accountHasLogin,
  ANTIGRAVITY_LOGIN_MARK,
  defaultProvider,
  ConfigError,
  CLAUDE_MODELS,
  discoverModels,
  PROVIDER_LABELS,
  readModelCatalogCache,
  readTelegramSettings,
  type CommandSpec,
  type ModelCatalog,
  telegramCall,
  writeTelegramSettings,
  type Account,
  type Engine,
  type NexusConfig,
  type TelegramSettings,
} from "@nexus/shared";
import { newPairingCode, TelegramBot } from "./telegram-bot.ts";
import { AssistantError, type AssistantDeps } from "./assistant.ts";
import { HttpError } from "./errors.ts";
import { createExtras } from "./extras.ts";
import { createPaperclipView } from "./paperclip-view.ts";
import { findWhisper, readVoiceSettings, transcribe, ToolInstaller, VoiceError } from "./voice.ts";
import { USAGE_PERIODS, usageReport, type UsagePeriod } from "./usage.ts";
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
  /** 모델 목록을 읽을 OpenCode 명령. 기본 "opencode" */
  opencodeCommand?: CommandSpec;
  /** Google 계정 모델 목록을 읽을 Antigravity CLI 명령. 기본 "agy" */
  agyCommand?: CommandSpec;
  /** 시험용: Whisper 대신 쓸 명령 */
  whisperCommand?: CommandSpec;
  /** 시험용: SenseVoice(sherpa-onnx-offline) 대신 쓸 명령 */
  senseVoiceCommand?: CommandSpec;
  /** Whisper·ffmpeg 설치 스크립트 폴더. 기본은 저장소의 scripts/windows */
  scriptsDir?: string;
  /** Paperclip 한국어 보기(중계) 번호. 기본은 port+1, port가 0이면 0 */
  paperclipViewPort?: number;
  /** 텔레그램 봇을 함께 돌린다. 생략하면 돌리지 않는다(테스트). */
  telegram?: { paperclipUrl?: string; apiBase?: string; pollSeconds?: number };
}

export interface SettingsServer {
  listen(): Promise<string>;
  close(): Promise<void>;
  readonly server: http.Server;
}

const BODY_LIMIT = 256 * 1024;
const AUDIO_LIMIT = 20 * 1024 * 1024;
/** 확장자 없이 여는 화면 */
const PAGES: Record<string, string> = { "/studio": "/studio.html", "/voice": "/voice.html", "/paperclip": "/paperclip.html" };
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const ENGINES: Engine[] = ["claude-code", "opencode", "antigravity"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};


function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "public"), path.join(here, "..", "public")]) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return path.join(here, "public");
}

/** 빌드할 때 남긴 커밋. 트레이 실행기가 오래된 서버를 알아보는 데 쓴다. 소스로 돌리면 null. */
function readBuild(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const commit = JSON.parse(readFileSync(path.join(here, "build.json"), "utf8")).commit;
    return typeof commit === "string" ? commit : null;
  } catch {
    return null;
  }
}

export function createSettingsServer(opts: SettingsServerOptions): SettingsServer {
  const publicDir = path.resolve(opts.publicDir ?? findPublicDir());
  const launcher = opts.launcher ?? defaultLauncher;
  let allowedHosts = new Set<string>();

  ensureConfigFiles(opts.configDir, opts.fallbackDir);
  const paperclipUrl = opts.telegram?.paperclipUrl ?? PaperclipClient.resolveBaseUrl();
  // Paperclip 화면을 Nexus 창 안에 띄울 수 있게 Paperclip 주소만 허락한다(localhost와 127.0.0.1 둘 다).
  // 한국어 메뉴를 붙여 보여 주는 중계 서버도 허락한다.
  const view = createPaperclipView({
    target: paperclipUrl,
    port: opts.paperclipViewPort ?? (opts.port === 0 ? 0 : (opts.port ?? 3200) + 1),
    scriptFile: path.join(publicDir, "paperclip-ko.js"),
  });
  let viewUrl: string | null = null;
  const directFrames = (() => {
    try {
      const u = new URL(paperclipUrl);
      const alt = u.hostname === "localhost" ? "127.0.0.1" : u.hostname === "127.0.0.1" ? "localhost" : null;
      return [u.origin, alt ? `${u.protocol}//${alt}${u.port ? `:${u.port}` : ""}` : null].filter(Boolean).join(" ");
    } catch {
      return "";
    }
  })();
  const paperclipFrames = () => [directFrames, view.port ? `http://127.0.0.1:${view.port} http://localhost:${view.port}` : ""].filter(Boolean).join(" ") || "'none'";
  const transcribeCommands = { whisper: opts.whisperCommand, sensevoice: opts.senseVoiceCommand };
  const bot = opts.telegram
    ? new TelegramBot({
        stateDir: opts.stateDir,
        paperclipUrl,
        apiBase: opts.telegram.apiBase,
        pollSeconds: opts.telegram.pollSeconds,
        usageText,
        todayCost,
        transcribe: (audio, ext) => {
          const s = readVoiceSettings(opts.stateDir);
          return transcribe(audio, ext, s, findWhisper(s), { commands: transcribeCommands, tmpDir: path.join(opts.stateDir, "tmp") });
        },
      })
    : null;
  const scriptsDir = opts.scriptsDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "windows");
  const installer = new ToolInstaller(scriptsDir);
  const assistantDeps = (): AssistantDeps => ({ stateDir: opts.stateDir, paperclipUrl, usageText, todayCost });
  const extras = createExtras({
    stateDir: opts.stateDir,
    paperclipUrl,
    assistant: assistantDeps,
    commands: transcribeCommands,
    installer,
    targets: (companyId) => paperclipTargets(companyId),
    build: readBuild(),
    viewUrl: () => viewUrl,
  });

  function todayCost(): number {
    try {
      return usageReport(loadValid().config, opts.stateDir, "today").totals.costUsd;
    } catch {
      return 0;
    }
  }

  /** Paperclip 회사와 그 회사의 에이전트 목록. 연결하지 못하면 이유를 돌려준다. */
  async function paperclipTargets(companyIdQuery: string | null | undefined) {
    const client = new PaperclipClient(paperclipUrl, undefined, "");
    let companies: Array<{ id: string; name: string }> = [];
    let agents: Array<{ id: string; name: string; adapterType: string }> = [];
    let paperclipError: string | null = null;
    try {
      companies = (await withTimeout(client.listCompanies(), 3000)).map((c) => ({ id: c.id, name: c.name ?? c.id }));
      const companyId = companyIdQuery ?? companies[0]?.id;
      if (companyId) agents = (await withTimeout(client.listAgents(companyId), 3000)).map((a) => ({ id: a.id, name: a.name ?? a.id, adapterType: a.adapterType ?? "" }));
    } catch {
      paperclipError = "Paperclip에 연결하지 못했어요. Paperclip을 켠 뒤 화면을 새로 고쳐 주세요.";
    }
    return { companies, agents, paperclipError };
  }

  /** 텔레그램 /usage 명령에 보낼 이번 달 사용량 */
  function usageText(): string {
    const { config } = loadValid();
    const r = usageReport(config, opts.stateDir, "month");
    const t = r.totals;
    const lines = [`이번 달 사용량: ${t.runs}번 실행, 성공 ${t.runs ? Math.round((t.ok / t.runs) * 100) : 0}%, 토큰 ${(t.inputTokens + t.outputTokens).toLocaleString("en-US")}개, $${t.costUsd.toFixed(2)}`];
    for (const a of r.accounts.filter((x) => x.totals.runs || x.budget)) {
      const b = a.budget;
      const budget = b ? ` · 예산 ${b.monthlyBudgetUsd ? `$${b.usedUsd.toFixed(2)}/$${b.monthlyBudgetUsd}` : `${b.usedTokens.toLocaleString("en-US")}/${b.monthlyTokenLimit!.toLocaleString("en-US")} 토큰`}${b.exceeded ? " (다 씀)" : ""}` : "";
      lines.push(`• ${a.label}: ${a.totals.runs}번, $${a.totals.costUsd.toFixed(2)}${budget}`);
    }
    for (const h of r.hints) lines.push(`💡 ${h.text}`);
    return lines.join("\n");
  }

  /** 설정 화면의 텔레그램 칸에 보여 줄 상태. 토큰은 내보내지 않는다. */
  async function telegramState(companyIdQuery: string | null) {
    const s = readTelegramSettings(opts.stateDir);
    const { companies, agents, paperclipError } = await paperclipTargets(companyIdQuery ?? s.companyId);
    const pairing = s.pairing && Date.parse(s.pairing.expiresAt) > Date.now() ? { code: s.pairing.code, expiresAt: s.pairing.expiresAt } : null;
    return {
      hasToken: Boolean(s.botToken),
      botName: s.botName ?? null,
      enabled: s.enabled,
      notifyResults: s.notifyResults,
      chats: s.chats,
      companyId: s.companyId ?? null,
      agentId: s.agentId ?? null,
      pairing,
      bot: bot ? bot.getStatus() : null,
      companies,
      agents,
      paperclipError,
    };
  }

  let discovering: Promise<ModelCatalog> | null = null;
  /** 연결해 둔 모델 목록. 캐시가 없거나 새로 고치라고 하면 OpenCode에 묻는다. */
  async function modelCatalog(refresh: boolean) {
    const { config } = loadValid();
    let catalog = refresh ? null : readModelCatalogCache(opts.stateDir);
    if (!catalog) {
      discovering ??= discoverModels({ stateDir: opts.stateDir, accounts: Object.values(config.accounts), opencodeCommand: opts.opencodeCommand, agyCommand: opts.agyCommand }).finally(() => {
        discovering = null;
      });
      catalog = await discovering;
    }
    // Claude 목록은 프로그램에 들어 있으니 캐시가 오래돼도 최신으로 보여 준다.
    const models = [...CLAUDE_MODELS, ...catalog.models.filter((m) => m.engine !== "claude-code")];
    return { ...catalog, models, providers: PROVIDER_LABELS };
  }

  function saveTelegram(mutate: (s: TelegramSettings) => void): void {
    const s = readTelegramSettings(opts.stateDir);
    mutate(s);
    writeTelegramSettings(opts.stateDir, s);
  }

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
        monthlyBudgetUsd: acc.monthlyBudgetUsd ?? null,
        monthlyTokenLimit: acc.monthlyTokenLimit ?? null,
        loggedIn: accountHasLogin(acc),
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
        results: config.routing.results,
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
      if (engine === "antigravity") {
        const other = Object.values(config.accounts).find((a) => a.engine === "antigravity");
        if (other) throw new HttpError(409, `Google 계정(Antigravity)은 하나만 쓸 수 있어요. 이미 '${other.label}' 계정이 있어요. Antigravity CLI가 로그인 정보를 Windows 자격 증명 관리자에 하나만 저장하기 때문이에요.`);
      }
      const provider = engine === "antigravity" ? "antigravity" : typeof body.provider === "string" && /^[a-z0-9._-]{1,40}$/i.test(body.provider.trim()) ? body.provider.trim() : defaultProvider(engine);
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
      const cmd = buildLoginCommand(account, { antigravityScript: path.join(scriptsDir, "antigravity-login.cmd") });
      const result = await launcher(cmd);
      if (account.engine === "antigravity") {
        // 로그인 정보는 파일로 확인할 수 없어서, 로그인 창을 연 것을 표시해 둔다.
        writeFileSync(path.join(account.dir, ANTIGRAVITY_LOGIN_MARK), new Date().toISOString());
        if (result.launched) return { ok: true, launched: true, message: "새 창이 열렸어요. Antigravity CLI가 없으면 먼저 설치하고, 브라우저가 열리면 Gemini를 구독한 Google 계정으로 로그인해 주세요. 끝나면 창을 닫고 'AI 모델' 칸에서 목록 새로 고침을 눌러 주세요." };
        return {
          ok: true,
          launched: false,
          commandText: result.commandText,
          message: "로그인 창을 자동으로 열지 못했어요. Antigravity CLI를 설치한 뒤(https://antigravity.google/docs/cli/install) 아래 명령을 터미널에서 실행하고, 브라우저에서 Google 계정으로 로그인해 주세요.",
        };
      }
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

    "/api/telegram/token": async (body) => {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new HttpError(400, "봇 토큰 모양이 아니에요. BotFather가 준 '숫자:영문' 형태의 토큰을 통째로 붙여 넣어 주세요.");
      let me: { username?: string; first_name?: string };
      try {
        me = await telegramCall(token, "getMe", {}, { apiBase: opts.telegram?.apiBase });
      } catch (err) {
        throw new HttpError(400, `텔레그램이 이 토큰을 받아 주지 않았어요: ${(err as Error).message}`);
      }
      const botName = me.username ? `@${me.username}` : (me.first_name ?? "봇");
      // 웹훅이 걸려 있으면 getUpdates로 받을 수 없어서 지운다.
      await telegramCall(token, "deleteWebhook", {}, { apiBase: opts.telegram?.apiBase }).catch(() => undefined);
      saveTelegram((s) => {
        if (s.botToken !== token) s.chats = [];
        s.botToken = token;
        s.botName = botName;
      });
      return { ok: true, message: `${botName} 봇을 연결했어요. 이제 '연결 코드 만들기'를 눌러 내 텔레그램과 짝지어 주세요.` };
    },

    "/api/telegram/token/remove": () => {
      saveTelegram((s) => {
        delete s.botToken;
        delete s.botName;
        delete s.pairing;
        s.chats = [];
      });
      return { ok: true, message: "봇 연결을 끊었어요." };
    },

    "/api/telegram/settings": async (body) => {
      const sentences: string[] = [];
      const companyId = typeof body.companyId === "string" ? body.companyId : undefined;
      const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
      if (companyId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(companyId)) throw new HttpError(400, "회사를 다시 골라 주세요.");
      if (agentId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) throw new HttpError(400, "에이전트를 다시 골라 주세요.");
      for (const key of ["enabled", "notifyResults"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") throw new HttpError(400, "켜거나 끄기만 할 수 있어요.");
      }
      saveTelegram((s) => {
        if (typeof body.enabled === "boolean") {
          s.enabled = body.enabled;
          sentences.push(body.enabled ? "텔레그램으로 일을 받아요." : "텔레그램으로 일을 받지 않아요.");
        }
        if (typeof body.notifyResults === "boolean") {
          s.notifyResults = body.notifyResults;
          sentences.push(body.notifyResults ? "작업이 끝나면 텔레그램으로 알려요." : "텔레그램으로 결과를 알리지 않아요.");
        }
        if (companyId !== undefined) {
          if (s.companyId !== companyId) delete s.agentId;
          s.companyId = companyId;
        }
        if (agentId !== undefined) s.agentId = agentId;
      });
      if (companyId !== undefined || agentId !== undefined) sentences.push("일을 맡길 곳을 바꿨어요.");
      return { ok: true, message: sentences.join(" ") || "저장했어요." };
    },

    "/api/telegram/pair": () => {
      const s = readTelegramSettings(opts.stateDir);
      if (!s.botToken) throw new HttpError(400, "먼저 봇 토큰을 넣어 주세요.");
      const pairing = newPairingCode();
      saveTelegram((x) => {
        x.pairing = pairing;
      });
      return { ok: true, code: pairing.code, expiresAt: pairing.expiresAt, botName: s.botName };
    },

    "/api/telegram/unlink": (body) => {
      const chatId = Number(body.chatId);
      saveTelegram((s) => {
        s.chats = s.chats.filter((c) => c.id !== chatId);
      });
      return { ok: true, message: "그 대화방과의 연결을 끊었어요." };
    },

    "/api/telegram/test": async () => {
      const s = readTelegramSettings(opts.stateDir);
      if (!s.botToken || !s.chats.length) throw new HttpError(400, "먼저 봇 토큰을 넣고 내 텔레그램과 연결해 주세요.");
      const failed: string[] = [];
      for (const chat of s.chats) {
        try {
          await telegramCall(s.botToken, "sendMessage", { chat_id: chat.id, text: "Nexus 시험 메시지예요. 이 메시지가 보이면 연결된 거예요." }, { apiBase: opts.telegram?.apiBase });
        } catch (err) {
          failed.push(`${chat.name}: ${(err as Error).message}`);
        }
      }
      if (failed.length) throw new HttpError(502, "일부 대화방에 보내지 못했어요.", failed);
      return { ok: true, message: "시험 메시지를 보냈어요. 텔레그램을 확인해 주세요." };
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

  function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, "소리가 너무 길어요. 짧게 나눠 말해 주세요."));
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on("data", (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > limit) {
          failed = true;
          reject(new HttpError(413, "소리가 너무 길어요. 짧게 나눠 말해 주세요."));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!failed) resolve(Buffer.concat(chunks));
      });
      req.on("error", reject);
    });
  }

  function serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === "/" ? "/index.html" : PAGES[pathname] ?? pathname);
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
      "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src ${paperclipFrames()}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
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
      if (pathname === "/api/telegram") {
        if (req.method !== "GET") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        const companyId = url.searchParams.get("companyId");
        return send(res, 200, { ok: true, ...(await telegramState(companyId && /^[A-Za-z0-9_-]{1,80}$/.test(companyId) ? companyId : null)) });
      }
      if (pathname === "/api/models") {
        if (req.method !== "GET") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        return send(res, 200, { ok: true, ...(await modelCatalog(url.searchParams.get("refresh") === "1")) });
      }
      if (pathname === "/api/usage") {
        if (req.method !== "GET") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        const period = (url.searchParams.get("period") ?? "month") as UsagePeriod;
        if (!USAGE_PERIODS.includes(period)) throw new HttpError(400, "기간은 today, 7d, 30d, month 중 하나예요.");
        const { config } = loadValid();
        return send(res, 200, { ok: true, ...usageReport(config, opts.stateDir, period) });
      }
      const getter = extras.get[pathname];
      if (getter) {
        if (req.method !== "GET") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        return send(res, 200, { ok: true, ...(await getter(url)) });
      }
      if (pathname === "/api/archive/media") {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        return extras.media(url, req, res);
      }
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (pathname === "/api/voice/transcribe") {
        if (req.method !== "POST") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
        if (req.headers["x-nexus"] !== "1" || !contentType.startsWith("audio/")) {
          return send(res, 403, { ok: false, error: "음성 비서 화면에서 보낸 요청만 받아요. 화면을 새로 고쳐 주세요." });
        }
        const audio = await readRaw(req, AUDIO_LIMIT);
        return send(res, 200, { ok: true, ...(await extras.transcribe(audio, contentType)) });
      }
      const route = routes[pathname] ?? extras.post[pathname];
      if (!route) return send(res, 404, { ok: false, error: "찾는 기능이 없어요." });
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "지원하지 않는 요청이에요." });
      // CSRF 막기: 다른 사이트의 폼은 이 머리글과 JSON 형식을 보낼 수 없다.
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
      if (err instanceof VoiceError) return send(res, err.status, { ok: false, error: err.message, problems: [] });
      if (err instanceof AssistantError) return send(res, 400, { ok: false, error: err.message, problems: [] });
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
          bot?.start();
          void view.listen().then((u) => {
            viewUrl = u;
            resolve(`http://127.0.0.1:${port}/`);
          });
        });
      });
    },
    async close() {
      await bot?.stop();
      await view.close();
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
