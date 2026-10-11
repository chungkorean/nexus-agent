import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Engine, ModelAlias, TaskType } from "./types.ts";

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
}

export interface NexusConfig {
  aliases: Record<string, ModelAlias>;
  routing: RoutingPolicy;
}

const ENGINES: Engine[] = ["opencode", "claude-code"];
const TASK_TYPES: TaskType[] = ["design", "implement", "refactor", "test", "review", "docs", "research", "ops"];

export class ConfigError extends Error {}

/**
 * config 폴더의 models.yaml과 routing.yaml을 읽는다.
 * 파일이 없으면 저장소에 들어 있는 기본 설정을 쓴다.
 */
export function loadConfig(configDir: string, fallbackDir?: string): NexusConfig {
  const models = readYaml(configDir, "models.yaml", fallbackDir);
  const routing = readYaml(configDir, "routing.yaml", fallbackDir);
  return validateConfig(models, routing);
}

function readYaml(dir: string, name: string, fallbackDir?: string): unknown {
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
  throw new ConfigError(`${name} 파일을 찾지 못했어요 (${[dir, fallbackDir].filter(Boolean).join(", ")})`);
}

export function validateConfig(modelsRaw: unknown, routingRaw: unknown): NexusConfig {
  const problems: string[] = [];
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
      aliases[name] = { engine: v.engine, model: v.model, label: v.label, accountDir: v.accountDir };
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

  if (problems.length) throw new ConfigError(problems.join("\n"));

  return {
    aliases,
    routing: {
      defaultWhenUnsure: r.defaultWhenUnsure === "delegate" ? "delegate" : "execute",
      preferLocal: r.preferLocal === true,
      taskTypes,
      lightTaskTypes: (r.lightTaskTypes ?? ["test", "docs"]).filter((t): t is TaskType => TASK_TYPES.includes(t as TaskType)),
      highRiskAlias,
      maxFallbacks: typeof r.maxFallbacks === "number" ? r.maxFallbacks : 1,
    },
  };
}
