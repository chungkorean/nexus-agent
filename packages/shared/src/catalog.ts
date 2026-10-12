import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess, type CommandSpec } from "./process.ts";
import type { Account, Engine } from "./types.ts";

/** 설정 화면에서 고를 수 있는 모델 하나 */
export interface CatalogModel {
  engine: Engine;
  /** claude-code는 opus·claude-opus-5-5 같은 이름, antigravity는 gemini-3.1-pro-high 같은 agy 이름, opencode는 provider/model */
  id: string;
  /** 화면에 보여 줄 이름 (예: Claude Opus 5.5, DeepSeek V4.1 Flash) */
  name: string;
  /** 공급자 ID (anthropic, google, deepseek, xiaomi 등) */
  provider: string;
  /** 첫 화면에 바로 보여 줄 모델 */
  featured?: boolean;
  /** 문맥 길이(토큰) */
  context?: number;
  /** 100만 토큰당 달러 (입력/출력) */
  cost?: { input: number; output: number };
  /** 이 모델을 쓸 수 있는 계정 ID. 비어 있으면 평소 로그인 계정 */
  accounts?: string[];
}

export interface ModelCatalog {
  models: CatalogModel[];
  fetchedAt: string | null;
  /** 목록을 못 읽은 이유 (계정별) */
  errors: string[];
}

/**
 * Claude 구독(Claude Code)으로 쓸 수 있는 모델. Claude Code는 목록을 알려 주는 명령이 없어서 직접 둔다.
 * opus·sonnet·haiku는 그때그때 최신 모델을 가리킨다.
 */
export const CLAUDE_MODELS: CatalogModel[] = [
  { engine: "claude-code", provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", featured: true },
  { engine: "claude-code", provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", featured: true },
  { engine: "claude-code", provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", featured: true },
  { engine: "claude-code", provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", featured: true },
  { engine: "claude-code", provider: "anthropic", id: "opus", name: "Claude Opus (항상 최신)" },
  { engine: "claude-code", provider: "anthropic", id: "sonnet", name: "Claude Sonnet (항상 최신)" },
  { engine: "claude-code", provider: "anthropic", id: "haiku", name: "Claude Haiku (항상 최신)" },
  { engine: "claude-code", provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { engine: "claude-code", provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { engine: "claude-code", provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { engine: "claude-code", provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5" },
  { engine: "claude-code", provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { engine: "claude-code", provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { engine: "claude-code", provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { engine: "claude-code", provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

/**
 * Google 계정(Antigravity CLI)으로 쓸 수 있는 모델. `agy models`로 실제 목록을 읽지 못했을 때 보여 준다.
 * 이름 끝의 high·medium은 생각을 얼마나 깊게 하는지다.
 */
export const ANTIGRAVITY_MODELS: CatalogModel[] = [
  { engine: "antigravity", provider: "antigravity", id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", featured: true },
  { engine: "antigravity", provider: "antigravity", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", featured: true },
  { engine: "antigravity", provider: "antigravity", id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { engine: "antigravity", provider: "antigravity", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { engine: "antigravity", provider: "antigravity", id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
];

/**
 * agy 실행 파일. Windows 설치 프로그램은 %LOCALAPPDATA%\\agy\\bin에 넣고 PATH에 더하는데,
 * 설치 전에 켜 둔 Paperclip·Nexus는 새 PATH를 모르므로 그 자리에 있으면 전체 경로를 쓴다.
 */
export function defaultAgyCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && env.LOCALAPPDATA) {
    const exe = path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (existsSync(exe)) return exe;
  }
  return "agy";
}

/** `agy models` 출력 읽기: 한 줄에 "slug   표시 이름". 표시 이름이 없으면 slug만 있어도 읽는다. */
export function parseAgyModels(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^([a-z][a-z0-9._-]*-[a-z0-9._-]+)(?:\s+(.+))?$/i);
    if (!m) continue;
    out.push({ engine: "antigravity", provider: "antigravity", id: m[1]!, name: m[2]?.trim() || m[1]! });
  }
  return out;
}

const MODEL_LINE = /^([A-Za-z0-9._-]+)\/(\S+)$/;

/**
 * `opencode models --verbose` 출력 읽기. 모델마다 "provider/model" 한 줄 뒤에 JSON이 온다.
 * --verbose 없이 줄만 있어도 읽는다.
 */
export function parseOpencodeModels(text: string): CatalogModel[] {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const out: CatalogModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.trim().match(MODEL_LINE);
    if (!m) continue;
    const model: CatalogModel = { engine: "opencode", provider: m[1]!, id: `${m[1]}/${m[2]}`, name: m[2]! };
    if (lines[i + 1]?.trim().startsWith("{")) {
      let depth = 0;
      const buf: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j]!;
        buf.push(line);
        for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
        if (depth <= 0) break;
      }
      try {
        const info = JSON.parse(buf.join("\n")) as { name?: string; limit?: { context?: number }; cost?: { input?: number; output?: number }; status?: string };
        if (info.status === "deprecated") {
          i = j;
          continue;
        }
        if (info.name) model.name = info.name;
        if (info.limit?.context) model.context = info.limit.context;
        if (typeof info.cost?.input === "number" && typeof info.cost?.output === "number") model.cost = { input: info.cost.input, output: info.cost.output };
      } catch {
        /* 메타데이터를 못 읽어도 모델 ID는 쓴다 */
      }
      i = j;
    }
    out.push(model);
  }
  return out;
}

/** 공급자 ID를 사람이 읽는 이름으로 */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude 구독",
  antigravity: "Google 계정 (Gemini 구독)",
  meta: "Meta Muse",
  openai: "OpenAI",
  google: "Google Gemini (API 키)",
  "google-vertex": "Google Vertex",
  deepseek: "DeepSeek",
  xiaomi: "Xiaomi MiMo",
  moonshotai: "Moonshot (Kimi)",
  zhipuai: "Zhipu (GLM)",
  alibaba: "Alibaba (Qwen)",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  ollama: "Ollama (내 컴퓨터)",
  opencode: "OpenCode Zen",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI (Grok)",
  nvidia: "NVIDIA NIM",
  "amazon-bedrock": "Amazon Bedrock",
};

function cacheFile(stateDir: string): string {
  return path.join(stateDir, "models-cache.json");
}

export function readModelCatalogCache(stateDir: string): ModelCatalog | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(stateDir), "utf8")) as ModelCatalog;
    return Array.isArray(c.models) ? c : null;
  } catch {
    return null;
  }
}

/**
 * 연결해 둔 모델 전체를 찾는다. OpenCode는 평소 로그인과 OpenCode 계정 폴더마다
 * `opencode models --verbose`를 돌려 합치고, Claude 구독 모델을 앞에 붙인다. 결과는 state에 캐시한다.
 */
export async function discoverModels(opts: {
  stateDir: string;
  accounts: Account[];
  opencodeCommand?: CommandSpec;
  /** Antigravity CLI. Antigravity 계정이 있을 때만 `agy models`를 부른다. */
  agyCommand?: CommandSpec;
  timeoutSec?: number;
}): Promise<ModelCatalog> {
  const errors: string[] = [];
  const found = new Map<string, CatalogModel>();
  const targets: Array<{ label: string; accountId?: string; env: Record<string, string> }> = [{ label: "평소 로그인", env: {} }];
  for (const acc of opts.accounts.filter((a) => a.engine === "opencode")) targets.push({ label: acc.label, accountId: acc.id, env: { XDG_DATA_HOME: acc.dir } });

  for (const t of targets) {
    const res = await runProcess(opts.opencodeCommand ?? "opencode", ["models", "--verbose"], {
      cwd: os.homedir(),
      env: t.env,
      timeoutSec: opts.timeoutSec ?? 60,
    });
    if (res.spawnError) {
      errors.push("OpenCode를 찾지 못했어요. 'npm install -g opencode-ai'로 설치해 주세요.");
      break;
    }
    if (res.exitCode !== 0) {
      errors.push(`${t.label}: 모델 목록을 읽지 못했어요 (${(res.stderr || res.stdout).trim().split("\n").pop()?.slice(0, 200) ?? res.exitCode})`);
      continue;
    }
    for (const m of parseOpencodeModels(res.stdout)) {
      const prev = found.get(m.id);
      const accounts = [...new Set([...(prev?.accounts ?? []), ...(t.accountId ? [t.accountId] : [])])];
      found.set(m.id, { ...(prev ?? m), ...(accounts.length ? { accounts } : {}) });
    }
  }
  let google: CatalogModel[] = [];
  const agyAccounts = opts.accounts.filter((a) => a.engine === "antigravity");
  if (agyAccounts.length) {
    const res = await runProcess(opts.agyCommand ?? defaultAgyCommand(), ["models"], { cwd: os.homedir(), timeoutSec: opts.timeoutSec ?? 60 });
    const listed = res.exitCode === 0 ? parseAgyModels(res.stdout) : [];
    if (res.spawnError) errors.push("Antigravity CLI(agy)를 찾지 못했어요. 계정 칸의 설치 안내를 따라 설치해 주세요.");
    else if (!listed.length) errors.push(`Google 계정: 모델 목록을 읽지 못해 기본 목록을 보여 줘요 (${(res.stderr || res.stdout).trim().split("\n").pop()?.slice(0, 200) || res.exitCode})`);
    const featured = new Set(ANTIGRAVITY_MODELS.filter((m) => m.featured).map((m) => m.id));
    google = (listed.length ? listed : ANTIGRAVITY_MODELS).map((m) => ({ ...m, featured: featured.has(m.id) || undefined, accounts: agyAccounts.map((a) => a.id) }));
    for (const m of google) if (!m.featured) delete m.featured;
  }
  const catalog: ModelCatalog = {
    models: [...CLAUDE_MODELS, ...google, ...[...found.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))],
    fetchedAt: new Date().toISOString(),
    errors,
  };
  try {
    mkdirSync(opts.stateDir, { recursive: true });
    const tmp = `${cacheFile(opts.stateDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(catalog));
    renameSync(tmp, cacheFile(opts.stateDir));
  } catch {
    /* 캐시를 못 써도 목록은 돌려준다 */
  }
  return catalog;
}

/** 모델 ID로 별칭 이름을 만든다 (예: deepseek/deepseek-flash → deepseek-flash) */
export function aliasNameFor(modelId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    (modelId.split("/").pop() ?? modelId)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "model";
  let name = /^[a-z0-9]/.test(base) ? base : `m-${base}`.slice(0, 40);
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 36)}-${i}`;
  return name;
}
