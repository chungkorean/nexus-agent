import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { defaultAccountsDir } from "./paths.ts";
import type { Account, Engine, ModelAlias, TaskType } from "./types.ts";

export interface RoutingPolicy {
  /** 분류 신호가 없거나 비길 때의 판정. 개발 부서에 배정된 이슈라면 execute가 자연스럽다. */
  defaultWhenUnsure: "execute" | "delegate";
  /** 켜면 가벼운 작업을 local 별칭(Ollama 등)에 먼저 맡긴다. */
  preferLocal: boolean;
  /** 작업 종류 → 별칭 대체 순서. 앞에서부터 시도한다. */
  taskTypes: Record<TaskType, string[]>;
  /** preferLocal일 때 로컬 모델에 먼저 맡길 작업 종류 */
  lightTaskTypes: TaskType[];
  /** 위험도 높음 작업에 가장 먼저 쓸 별칭 */
  highRiskAlias: string;
  /** 공급자 오류일 때 대체 순서에서 몇 번까지 넘어갈지 */
  maxFallbacks: number;
  planning: PlanningPolicy;
  results: ResultPolicy;
}

/** 실행이 끝난 뒤 처리. Paperclip 에이전트 설정(adapterConfig)에 같은 이름이 있으면 그쪽이 우선한다. */
export interface ResultPolicy {
  /** 하위 작업이 모두 성공하면 브랜치를 작업 폴더의 현재 브랜치에 합친다. */
  autoMerge: boolean;
  /** 성공하면 이슈를 완료로 바꾼다. 실패하면 항상 막힘으로 바꾼다. */
  markDoneOnSuccess: boolean;
  /** 하위 작업 브랜치를 합치다 충돌하면 AI에게 한 번 풀게 한다. */
  resolveConflicts: boolean;
  /** 합친 결과로 프로젝트 테스트를 돌린다. */
  runTests: boolean;
  /** 테스트 명령. 비우면 package.json, pytest 설정 등을 보고 자동으로 찾는다. */
  testCommand: string;
  /** 합친 전체 변경을 구현과 다른 회사 모델에게 검토받는다. */
  review: boolean;
  /** 결과 브랜치를 GitHub(원격 저장소)에 올린다. 기본은 끔 */
  githubPush: boolean;
  /** 올린 결과 브랜치로 초안 풀 리퀘스트를 만든다(gh CLI 필요). 기본은 끔 */
  githubPullRequest: boolean;
  /** 올릴 원격 저장소 이름 */
  githubRemote: string;
}

export interface PlanningPolicy {
  /** auto: 큰 이슈만 나눔, always: 항상 나눔, never: 나누지 않음 */
  mode: "auto" | "always" | "never";
  /** 한 이슈를 최대 몇 개로 나눌지 */
  maxSubtasks: number;
  /** 동시에 몇 개까지 실행할지 */
  concurrency: number;
  /** 작업을 나누는 별칭. 실패하면 design 순서를 따른다. */
  planner: string;
}

export interface NexusConfig {
  aliases: Record<string, ModelAlias>;
  accounts: Record<string, Account>;
  routing: RoutingPolicy;
}

export const PLANNING_MODES = ["auto", "always", "never"] as const;

const ENGINES: Engine[] = ["opencode", "claude-code"];
const TASK_TYPES: TaskType[] = ["design", "implement", "refactor", "test", "review", "docs", "research", "ops"];

export class ConfigError extends Error {}

/**
 * config 폴더의 models.yaml과 routing.yaml을 읽는다.
 * 파일이 없으면 저장소에 들어 있는 기본 설정을 쓴다.
 */
export function loadConfig(configDir: string, fallbackDir?: string, accountsDir: string = defaultAccountsDir()): NexusConfig {
  const models = readYaml(configDir, "models.yaml", fallbackDir);
  const routing = readYaml(configDir, "routing.yaml", fallbackDir);
  const accounts = readYaml(configDir, "accounts.yaml", fallbackDir, true);
  return validateConfig(models, routing, accounts, accountsDir);
}

/** 실제로 읽을 설정 파일 경로. 사용자 폴더에 없으면 기본 설정 폴더의 파일 */
export function resolveConfigFile(dir: string, name: string, fallbackDir?: string): string | null {
  for (const candidate of [dir, fallbackDir]) {
    if (candidate && existsSync(path.join(candidate, name))) return path.join(candidate, name);
  }
  return null;
}

function readYaml(dir: string, name: string, fallbackDir?: string, optional = false): unknown {
  for (const candidate of [dir, fallbackDir]) {
    if (!candidate) continue;
    const file = path.join(candidate, name);
    if (existsSync(file)) {
      try {
        return parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new ConfigError(`${file}을 읽지 못했어요: ${(err as Error).message}`);
      }
    }
  }
  if (optional) return undefined;
  throw new ConfigError(`${name} 파일을 찾지 못했어요 (${[dir, fallbackDir].filter(Boolean).join(", ")})`);
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function validateConfig(modelsRaw: unknown, routingRaw: unknown, accountsRaw?: unknown, accountsDir: string = defaultAccountsDir()): NexusConfig {
  const problems: string[] = [];

  const accounts: Record<string, Account> = {};
  const rawAccounts = (accountsRaw as { accounts?: Record<string, unknown> } | null | undefined)?.accounts;
  if (rawAccounts && typeof rawAccounts === "object") {
    for (const [id, value] of Object.entries(rawAccounts)) {
      const v = value as Partial<Account> | null;
      if (!ACCOUNT_ID.test(id)) {
        problems.push(`계정 ${id}: 이름은 영문·숫자·-·_로 40자 안에서 지어 주세요`);
        continue;
      }
      if (!v || !v.engine || !ENGINES.includes(v.engine)) {
        problems.push(`계정 ${id}: engine은 ${ENGINES.join(" 또는 ")}이어야 해요`);
        continue;
      }
      accounts[id] = {
        id,
        engine: v.engine,
        provider: typeof v.provider === "string" && v.provider ? v.provider : v.engine === "claude-code" ? "anthropic" : "opencode",
        label: typeof v.label === "string" && v.label ? v.label : id,
        dir: typeof v.dir === "string" && v.dir ? v.dir : path.join(accountsDir, id),
      };
    }
  }

  const aliases: Record<string, ModelAlias> = {};
  const rawAliases = (modelsRaw as { aliases?: Record<string, unknown> } | null)?.aliases;
  if (!rawAliases || typeof rawAliases !== "object") {
    problems.push("models.yaml에 aliases 항목이 없어요");
  } else {
    for (const [name, value] of Object.entries(rawAliases)) {
      const v = value as Partial<ModelAlias> | null;
      if (!v || !v.engine || !ENGINES.includes(v.engine)) {
        problems.push(`별칭 ${name}: engine은 ${ENGINES.join(" 또는 ")}이어야 해요`);
        continue;
      }
      if (!v.model || typeof v.model !== "string") {
        problems.push(`별칭 ${name}: model이 비어 있어요`);
        continue;
      }
      if (v.engine === "opencode" && !v.model.includes("/")) {
        problems.push(`별칭 ${name}: OpenCode 모델은 provider/model 형식이어야 해요 (예: openai/gpt-5)`);
        continue;
      }
      let aliasAccounts: string[] | undefined;
      if (v.accounts !== undefined && v.accounts !== null) {
        const list = Array.isArray(v.accounts) ? v.accounts : [v.accounts];
        aliasAccounts = [];
        for (const id of list) {
          const acc = accounts[String(id)];
          if (!acc) problems.push(`별칭 ${name}: 없는 계정 ${id}을 가리켜요 (accounts.yaml 확인)`);
          else if (acc.engine !== v.engine) problems.push(`별칭 ${name}: 계정 ${id}은 ${acc.engine}용이라 ${v.engine} 모델에 쓸 수 없어요`);
          else aliasAccounts.push(acc.id);
        }
      }
      aliases[name] = { engine: v.engine, model: v.model, label: v.label, accountDir: v.accountDir, ...(aliasAccounts?.length ? { accounts: aliasAccounts } : {}) };
    }
  }

  const r = (routingRaw ?? {}) as Partial<RoutingPolicy> & { taskTypes?: Record<string, string[]> };
  const taskTypes = {} as Record<TaskType, string[]>;
  for (const t of TASK_TYPES) {
    const chain = r.taskTypes?.[t];
    if (!Array.isArray(chain) || chain.length === 0) {
      problems.push(`routing.yaml: ${t} 작업의 대체 순서가 비어 있어요`);
      continue;
    }
    const unknown = chain.filter((a) => !aliases[a]);
    if (unknown.length) problems.push(`routing.yaml: ${t} 작업이 없는 별칭을 가리켜요 (${unknown.join(", ")})`);
    taskTypes[t] = chain;
  }
  const highRiskAlias = r.highRiskAlias ?? "smart";
  if (!aliases[highRiskAlias]) problems.push(`routing.yaml: highRiskAlias(${highRiskAlias})가 없는 별칭이에요`);

  const p = (r as { planning?: Partial<PlanningPolicy> }).planning ?? {};
  const mode = p.mode ?? "auto";
  if (!PLANNING_MODES.includes(mode)) problems.push(`routing.yaml: planning.mode는 auto, always, never 중 하나여야 해요`);
  const planner = p.planner ?? highRiskAlias;
  if (!aliases[planner]) problems.push(`routing.yaml: planning.planner(${planner})가 없는 별칭이에요`);

  if (problems.length) throw new ConfigError(problems.join("\n"));

  return {
    aliases,
    accounts,
    routing: {
      defaultWhenUnsure: r.defaultWhenUnsure === "delegate" ? "delegate" : "execute",
      preferLocal: r.preferLocal === true,
      taskTypes,
      lightTaskTypes: (r.lightTaskTypes ?? ["test", "docs"]).filter((t): t is TaskType => TASK_TYPES.includes(t as TaskType)),
      highRiskAlias,
      maxFallbacks: typeof r.maxFallbacks === "number" ? r.maxFallbacks : 1,
      planning: {
        mode,
        maxSubtasks: clampInt(p.maxSubtasks, 2, 10, 5),
        concurrency: clampInt(p.concurrency, 1, 8, 3),
        planner,
      },
      results: readResults((r as { results?: Partial<ResultPolicy> }).results ?? {}),
    },
  };
}

function readResults(res: Partial<ResultPolicy>): ResultPolicy {
  return {
    autoMerge: res.autoMerge !== false,
    markDoneOnSuccess: res.markDoneOnSuccess !== false,
    resolveConflicts: res.resolveConflicts !== false,
    runTests: res.runTests !== false,
    testCommand: typeof res.testCommand === "string" ? res.testCommand.trim() : "",
    review: res.review !== false,
    githubPush: res.githubPush === true,
    githubPullRequest: res.githubPullRequest === true,
    githubRemote: typeof res.githubRemote === "string" && res.githubRemote.trim() ? res.githubRemote.trim() : "origin",
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
