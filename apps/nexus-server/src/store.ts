// 사용자 설정 폴더의 YAML 세 개를 읽고, 바꾸고, 백업하고, 되돌리는 일을 맡는다.
// yaml 라이브러리의 Document API로 고쳐서 사용자가 적어 둔 주석과 배치를 최대한 지킨다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLSeq } from "yaml";
import { ConfigError, PLANNING_MODES, validateConfig, type Engine, type NexusConfig, type TaskType } from "@nexus/shared";

export const CONFIG_FILES = { models: "models.yaml", routing: "routing.yaml", accounts: "accounts.yaml" } as const;
export type FileKey = keyof typeof CONFIG_FILES;
const FILE_KEYS = Object.keys(CONFIG_FILES) as FileKey[];

/** 화면에 보여 줄 순서와 이름 */
export const TASK_TYPE_NAMES: [TaskType, string][] = [
  ["design", "설계"],
  ["implement", "구현"],
  ["refactor", "리팩터"],
  ["test", "테스트 작성"],
  ["review", "리뷰"],
  ["docs", "문서"],
  ["research", "조사·분석"],
  ["ops", "터미널·파일 작업"],
];
const TASK_NAME = Object.fromEntries(TASK_TYPE_NAMES) as Record<TaskType, string>;

export const PLANNING_MODE_NAMES: Record<(typeof PLANNING_MODES)[number], string> = { auto: "자동", always: "항상", never: "안 함" };

export const LIMITS = {
  maxFallbacks: [0, 3],
  concurrency: [1, 5],
  maxSubtasks: [2, 8],
} as const;

export const MAX_BACKUPS = 20;

const ALIAS_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** 예산 칸에 적을 수 있는 최댓값 */
export const BUDGET_LIMITS = { usd: 100_000, tokens: 100_000_000_000 } as const;

/** 화면에서 보내는 변경 내용. 바꾼 항목만 담으면 된다. */
export interface SettingsChanges {
  /** 작업 종류별 1순위·2순위 별칭. second가 null이면 2순위 없음 */
  taskTypes?: Partial<Record<TaskType, { first: string; second: string | null }>>;
  /** 별칭별 표시 이름·모델 ID·사용할 계정 목록 (빈 배열이면 평소 로그인 계정) */
  aliases?: Record<string, { label?: string; model?: string; accounts?: string[] }>;
  /** 새로 추가할 모델(별칭). 이름은 영문 */
  newAliases?: Record<string, { engine: Engine; model: string; label?: string; accounts?: string[] }>;
  /** 지울 모델(별칭). 작업 순서에서도 빠진다 */
  removeAliases?: string[];
  preferLocal?: boolean;
  maxFallbacks?: number;
  highRiskAlias?: string;
  planning?: { mode?: "auto" | "always" | "never"; concurrency?: number; maxSubtasks?: number; planner?: string };
  /** 실행이 끝난 뒤 처리 */
  /** 계정별 월 예산. null이나 0이면 예산 없음 */
  budgets?: Record<string, { monthlyBudgetUsd?: number | null; monthlyTokenLimit?: number | null }>;
  results?: { autoMerge?: boolean; markDoneOnSuccess?: boolean; resolveConflicts?: boolean; runTests?: boolean; review?: boolean; testCommand?: string; githubPush?: boolean; githubPullRequest?: boolean; githubRemote?: string };
}

export interface LoadedFiles {
  docs: Record<FileKey, Document>;
  eol: Record<FileKey, "\n" | "\r\n">;
}

/** 첫 실행: 사용자 폴더에 없는 설정 파일을 기본 설정 폴더에서 복사해 온다. */
export function ensureConfigFiles(configDir: string, fallbackDir?: string): string[] {
  mkdirSync(configDir, { recursive: true });
  const copied: string[] = [];
  for (const name of Object.values(CONFIG_FILES)) {
    const target = path.join(configDir, name);
    if (existsSync(target)) continue;
    const source = fallbackDir ? path.join(fallbackDir, name) : null;
    if (source && existsSync(source)) {
      copyFileSync(source, target);
      copied.push(name);
    } else if (name === CONFIG_FILES.accounts) {
      writeFileSync(target, "# 로그인해 둔 AI 계정 목록\naccounts: {}\n");
      copied.push(name);
    }
  }
  return copied;
}

export function loadFiles(configDir: string): LoadedFiles {
  const docs = {} as Record<FileKey, Document>;
  const eol = {} as Record<FileKey, "\n" | "\r\n">;
  for (const key of FILE_KEYS) {
    const name = CONFIG_FILES[key];
    const file = path.join(configDir, name);
    let text = "";
    if (existsSync(file)) text = readFileSync(file, "utf8").replace(/^﻿/, "");
    else if (key !== "accounts") throw new ConfigError(`${name} 파일이 없어요. 설정 화면을 다시 켜 주세요.`);
    eol[key] = text.includes("\r\n") ? "\r\n" : "\n";
    const doc = parseDocument(text);
    if (doc.errors.length) {
      const line = doc.errors[0]!.linePos?.[0]?.line;
      throw new ConfigError(`${name} 파일 내용에 문제가 있어요${line ? ` (${line}번째 줄 근처)` : ""}. '되돌리기'를 눌러 이전 설정으로 돌아가 보세요.`);
    }
    docs[key] = doc;
  }
  return { docs, eol };
}

export function serialize(doc: Document, eol: "\n" | "\r\n"): string {
  const text = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  return eol === "\n" ? text : text.replace(/\r?\n/g, "\r\n");
}

/** 문서 세 개를 검사한다. 문제가 있으면 문제 목록, 없으면 설정 */
export function check(loaded: LoadedFiles, accountsDir: string): { config: NexusConfig; problems: [] } | { config: null; problems: string[] } {
  try {
    const { models, routing, accounts } = loaded.docs;
    return { config: validateConfig(models.toJS(), routing.toJS(), accounts.toJS() ?? undefined, accountsDir), problems: [] };
  } catch (err) {
    if (err instanceof ConfigError) return { config: null, problems: err.message.split("\n").filter(Boolean) };
    throw err;
  }
}

function setScalar(doc: Document, keys: (string | number)[], value: string | number | boolean): void {
  const node = doc.getIn(keys, true);
  if (isScalar(node)) {
    node.value = value;
    return;
  }
  const s = new Scalar(value);
  if (typeof value === "string") s.type = Scalar.QUOTE_DOUBLE;
  doc.setIn(keys, s);
}

function setList(doc: Document, keys: string[], values: string[]): void {
  const node = doc.getIn(keys, true);
  if (isSeq(node)) {
    // 기존 목록 노드를 그대로 두고 내용만 바꿔야 [a, b] 모양과 줄 끝 주석이 남는다.
    node.items = values.map((v) => new Scalar(v));
    return;
  }
  const seq = new YAMLSeq();
  seq.flow = true;
  seq.items = values.map((v) => new Scalar(v));
  doc.setIn(keys, seq);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function intIn(v: unknown, [min, max]: readonly [number, number]): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * 변경 내용을 문서에 적용하고, 사람이 읽을 문장과 입력 문제를 돌려준다.
 * 저장 전 검사(validateConfig)는 따로 한다.
 */
export function applyChanges(
  loaded: LoadedFiles,
  current: NexusConfig,
  changesRaw: unknown,
): { sentences: string[]; problems: string[]; dirty: Set<FileKey> } {
  const sentences: string[] = [];
  const problems: string[] = [];
  const dirty = new Set<FileKey>();
  if (!isPlainObject(changesRaw)) return { sentences, problems: ["보낸 내용을 이해하지 못했어요. 화면을 새로 고쳐 주세요."], dirty };
  const changes = changesRaw as SettingsChanges;
  const { models, routing, accounts } = loaded.docs;

  // 문장에는 바뀐 뒤의 표시 이름을 쓴다.
  const newLabels: Record<string, string> = {};
  if (isPlainObject(changes.aliases)) {
    for (const [name, c] of Object.entries(changes.aliases)) {
      if (isPlainObject(c) && typeof c.label === "string" && c.label.trim()) newLabels[name] = c.label.trim();
    }
  }
  const label = (alias: string | null | undefined): string => {
    if (!alias) return "없음";
    return newLabels[alias] ?? current.aliases[alias]?.label ?? alias;
  };

  // 모델 추가와 삭제를 먼저 처리해, 같은 저장에서 새 모델을 작업 순서에 바로 쓸 수 있게 한다.
  const created = new Set<string>();
  const removed = new Set<string>();
  if (changes.newAliases !== undefined) {
    if (!isPlainObject(changes.newAliases)) problems.push("새로 추가한 AI 모델을 이해하지 못했어요.");
    else
      for (const [name, c] of Object.entries(changes.newAliases)) {
        if (!isPlainObject(c)) continue;
        const engine = c.engine as Engine;
        const model = typeof c.model === "string" ? c.model.trim() : "";
        const lbl = typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 80) : model;
        if (!ALIAS_NAME.test(name) || current.aliases[name]) problems.push(`'${lbl}' 모델의 영문 이름(${name})을 쓸 수 없어요. 화면을 새로 고쳐 주세요.`);
        else if (engine !== "claude-code" && engine !== "opencode") problems.push(`'${lbl}' 모델의 종류를 알 수 없어요.`);
        else if (!model || (engine === "opencode") !== model.includes("/")) problems.push(`'${lbl}' 모델 ID가 올바르지 않아요.`);
        else {
          const node: Record<string, unknown> = { engine, model, label: lbl };
          const accs = Array.isArray(c.accounts) ? [...new Set(c.accounts.filter((a): a is string => typeof a === "string"))] : [];
          if (accs.length) node.accounts = accs;
          models.setIn(["aliases", name], models.createNode(node));
          dirty.add("models");
          created.add(name);
          newLabels[name] = lbl;
          sentences.push(`AI 모델 추가: ${lbl}`);
        }
      }
  }
  if (changes.removeAliases !== undefined) {
    if (!Array.isArray(changes.removeAliases)) problems.push("지울 AI 모델을 이해하지 못했어요.");
    else
      for (const name of changes.removeAliases) {
        if (typeof name !== "string" || !current.aliases[name]) continue;
        removed.add(name);
        models.deleteIn(["aliases", name]);
        dirty.add("models");
        sentences.push(`AI 모델 삭제: ${label(name)}`);
      }
  }
  const exists = (name: unknown): name is string => typeof name === "string" && ((Boolean(current.aliases[name]) && !removed.has(name)) || created.has(name));
  const accountNames = (ids: string[] | undefined): string =>
    ids && ids.length ? ids.map((id) => current.accounts[id]?.label ?? id).join(", ") : "평소 로그인한 계정";

  // 작업별 1순위·2순위. 3순위 이후는 그대로 둔다.
  if (changes.taskTypes !== undefined) {
    if (!isPlainObject(changes.taskTypes)) problems.push("작업별 담당 AI 변경 내용을 이해하지 못했어요.");
    else
      for (const [t, c] of Object.entries(changes.taskTypes)) {
        if (!(t in TASK_NAME)) {
          problems.push(`알 수 없는 작업 종류예요: ${t}`);
          continue;
        }
        const type = t as TaskType;
        const name = TASK_NAME[type];
        if (!isPlainObject(c)) continue;
        const first = c.first;
        const second = c.second ?? null;
        if (!exists(first)) {
          problems.push(`${name} 작업의 1순위 AI를 골라 주세요.`);
          continue;
        }
        if (second !== null && !exists(second)) {
          problems.push(`${name} 작업의 2순위로 고른 AI를 찾지 못했어요.`);
          continue;
        }
        if (second === first) {
          problems.push(`${name} 작업의 1순위와 2순위가 같아요. 2순위는 다른 AI로 골라 주세요.`);
          continue;
        }
        const prev = current.routing.taskTypes[type] ?? [];
        // 2순위를 '없음'으로 고르면 대신 넘어갈 AI가 없다는 뜻이라 뒤 순서도 비운다.
        const next = second ? [first, second, ...prev.slice(2).filter((a) => a !== first && a !== second && exists(a))] : [first];
        if (next.join("\n") === prev.join("\n")) continue;
        setList(routing, ["taskTypes", type], next);
        dirty.add("routing");
        if (prev[0] !== first) sentences.push(`${name} 작업의 1순위: ${label(prev[0])} → ${label(first)}`);
        if ((prev[1] ?? null) !== second) sentences.push(`${name} 작업의 2순위: ${label(prev[1])} → ${label(second)}`);
        else if (!second && prev.length > 1) sentences.push(`${name} 작업은 1순위 AI만 써요`);
      }
  }

  const aliasSentences: string[] = [];
  // 별칭: 표시 이름, 모델 ID, 계정
  if (changes.aliases !== undefined) {
    if (!isPlainObject(changes.aliases)) problems.push("AI 모델 변경 내용을 이해하지 못했어요.");
    else
      for (const [name, c] of Object.entries(changes.aliases)) {
        const alias = current.aliases[name];
        if (removed.has(name) || created.has(name)) continue;
        if (!alias) {
          problems.push(`'${name}' AI 모델을 찾지 못했어요. 화면을 새로 고쳐 주세요.`);
          continue;
        }
        if (!isPlainObject(c)) continue;
        const oldLabel = alias.label ?? name;
        if (c.label !== undefined) {
          const v = typeof c.label === "string" ? c.label.trim() : "";
          if (!v) problems.push(`${oldLabel}: 이름을 비워 둘 수 없어요.`);
          else if (v.length > 80) problems.push(`${oldLabel}: 이름은 80자 안으로 적어 주세요.`);
          else if (v !== oldLabel) {
            setScalar(models, ["aliases", name, "label"], v);
            dirty.add("models");
            aliasSentences.push(`AI 모델 이름: ${oldLabel} → ${v}`);
          }
        }
        if (c.model !== undefined) {
          const v = typeof c.model === "string" ? c.model.trim() : "";
          if (!v) problems.push(`${label(name)}: 모델 ID를 비워 둘 수 없어요.`);
          else if (v !== alias.model) {
            setScalar(models, ["aliases", name, "model"], v);
            dirty.add("models");
            aliasSentences.push(`${label(name)}의 모델 ID: ${alias.model} → ${v}`);
          }
        }
        if (c.accounts !== undefined) {
          if (!Array.isArray(c.accounts) || !c.accounts.every((a) => typeof a === "string")) {
            problems.push(`${label(name)}: 계정 목록을 이해하지 못했어요.`);
          } else {
            const next = [...new Set(c.accounts)];
            const prev = alias.accounts ?? [];
            if (next.join("\n") !== prev.join("\n")) {
              if (next.length) setList(models, ["aliases", name, "accounts"], next);
              else models.deleteIn(["aliases", name, "accounts"]);
              dirty.add("models");
              aliasSentences.push(`${label(name)}에 쓸 계정: ${accountNames(prev)} → ${accountNames(next)}`);
            }
          }
        }
      }
  }

  const r = current.routing;
  if (changes.preferLocal !== undefined) {
    if (typeof changes.preferLocal !== "boolean") problems.push("내 컴퓨터 모델 먼저 쓰기 값을 이해하지 못했어요.");
    else if (changes.preferLocal !== r.preferLocal) {
      setScalar(routing, ["preferLocal"], changes.preferLocal);
      dirty.add("routing");
      const onOff = (v: boolean) => (v ? "켜짐" : "꺼짐");
      sentences.push(`내 컴퓨터 모델 먼저 쓰기: ${onOff(r.preferLocal)} → ${onOff(changes.preferLocal)}`);
    }
  }
  if (changes.maxFallbacks !== undefined) {
    if (!intIn(changes.maxFallbacks, LIMITS.maxFallbacks)) problems.push("다른 AI로 넘어가는 횟수는 0번에서 3번 사이로 골라 주세요.");
    else if (changes.maxFallbacks !== r.maxFallbacks) {
      setScalar(routing, ["maxFallbacks"], changes.maxFallbacks);
      dirty.add("routing");
      const times = (n: number) => (n === 0 ? "넘어가지 않음" : `${n}번`);
      sentences.push(`실패하면 다른 AI로 넘어가는 횟수: ${times(r.maxFallbacks)} → ${times(changes.maxFallbacks)}`);
    }
  }
  if (changes.highRiskAlias !== undefined) {
    if (!exists(changes.highRiskAlias)) problems.push("위험한 작업에 먼저 쓸 AI를 다시 골라 주세요.");
    else if (changes.highRiskAlias !== r.highRiskAlias) {
      setScalar(routing, ["highRiskAlias"], changes.highRiskAlias);
      dirty.add("routing");
      sentences.push(`위험한 작업에 먼저 쓸 AI: ${label(r.highRiskAlias)} → ${label(changes.highRiskAlias)}`);
    }
  }
  if (changes.planning !== undefined) {
    const p = changes.planning;
    if (!isPlainObject(p)) problems.push("작업 나누기 변경 내용을 이해하지 못했어요.");
    else {
      if (p.mode !== undefined) {
        if (!PLANNING_MODES.includes(p.mode as never)) problems.push("작업 나누기는 자동, 항상, 안 함 중에서 골라 주세요.");
        else if (p.mode !== r.planning.mode) {
          setScalar(routing, ["planning", "mode"], p.mode);
          dirty.add("routing");
          sentences.push(`작업 나누기: ${PLANNING_MODE_NAMES[r.planning.mode]} → ${PLANNING_MODE_NAMES[p.mode]}`);
        }
      }
      if (p.planner !== undefined) {
        if (!exists(p.planner)) problems.push("작업을 나눌 AI를 다시 골라 주세요.");
        else if (p.planner !== r.planning.planner) {
          setScalar(routing, ["planning", "planner"], p.planner);
          dirty.add("routing");
          sentences.push(`작업을 나눌 AI: ${label(r.planning.planner)} → ${label(p.planner)}`);
        }
      }
      if (p.concurrency !== undefined) {
        if (!intIn(p.concurrency, LIMITS.concurrency)) problems.push("동시에 실행할 작업 수는 1개에서 5개 사이로 골라 주세요.");
        else if (p.concurrency !== r.planning.concurrency) {
          setScalar(routing, ["planning", "concurrency"], p.concurrency);
          dirty.add("routing");
          sentences.push(`동시에 실행할 작업 수: ${r.planning.concurrency}개 → ${p.concurrency}개`);
        }
      }
      if (p.maxSubtasks !== undefined) {
        if (!intIn(p.maxSubtasks, LIMITS.maxSubtasks)) problems.push("최대 몇 개로 나눌지는 2개에서 8개 사이로 골라 주세요.");
        else if (p.maxSubtasks !== r.planning.maxSubtasks) {
          setScalar(routing, ["planning", "maxSubtasks"], p.maxSubtasks);
          dirty.add("routing");
          sentences.push(`한 작업을 나눌 최대 개수: ${r.planning.maxSubtasks}개 → ${p.maxSubtasks}개`);
        }
      }
    }
  }

  if (changes.results !== undefined) {
    const res = changes.results;
    if (!isPlainObject(res)) problems.push("작업이 끝난 뒤 처리 변경 내용을 이해하지 못했어요.");
    else {
      const names = {
        autoMerge: "성공하면 결과를 작업 폴더에 자동으로 합치기",
        markDoneOnSuccess: "성공하면 이슈를 완료로 바꾸기",
        resolveConflicts: "합치다 충돌하면 AI에게 풀게 하기",
        runTests: "합친 결과로 테스트 돌리기",
        review: "다른 회사 AI에게 전체 변경 검토받기",
        githubPush: "결과 브랜치를 GitHub에 올리기",
        githubPullRequest: "GitHub에 초안 풀 리퀘스트 만들기",
      } as const;
      for (const key of ["autoMerge", "markDoneOnSuccess", "resolveConflicts", "runTests", "review", "githubPush", "githubPullRequest"] as const) {
        const v = res[key];
        if (v === undefined) continue;
        if (typeof v !== "boolean") problems.push(`${names[key]}는 켜거나 끄기만 할 수 있어요.`);
        else if (v !== r.results[key]) {
          setScalar(routing, ["results", key], v);
          dirty.add("routing");
          sentences.push(`${names[key]}: ${r.results[key] ? "켜짐" : "꺼짐"} → ${v ? "켜짐" : "꺼짐"}`);
        }
      }
      if (res.githubRemote !== undefined) {
        if (typeof res.githubRemote !== "string" || !/^[A-Za-z0-9._-]{1,50}$/.test(res.githubRemote.trim())) problems.push("원격 저장소 이름은 영문, 숫자, 점, 밑줄, 빼기만 써 주세요 (예: origin).");
        else if (res.githubRemote.trim() !== r.results.githubRemote) {
          setScalar(routing, ["results", "githubRemote"], res.githubRemote.trim());
          dirty.add("routing");
          sentences.push(`올릴 원격 저장소: ${r.results.githubRemote} → ${res.githubRemote.trim()}`);
        }
      }
      if (res.testCommand !== undefined) {
        if (typeof res.testCommand !== "string" || res.testCommand.length > 300 || /[\r\n]/.test(res.testCommand)) problems.push("테스트 명령은 300자 이하의 한 줄로 적어 주세요.");
        else if (res.testCommand.trim() !== r.results.testCommand) {
          const v = res.testCommand.trim();
          setScalar(routing, ["results", "testCommand"], v);
          dirty.add("routing");
          sentences.push(`테스트 명령: ${r.results.testCommand || "자동으로 찾기"} → ${v || "자동으로 찾기"}`);
        }
      }
    }
  }

  if (changes.budgets !== undefined) {
    if (!isPlainObject(changes.budgets)) problems.push("예산 변경 내용을 이해하지 못했어요.");
    else
      for (const [id, c] of Object.entries(changes.budgets)) {
        const acc = current.accounts[id];
        if (!acc) {
          problems.push(`'${id}' 계정을 찾지 못했어요. 화면을 새로 고쳐 주세요.`);
          continue;
        }
        if (!isPlainObject(c)) continue;
        const fields = [
          ["monthlyBudgetUsd", "월 예산", (n: number) => `$${n}`, BUDGET_LIMITS.usd],
          ["monthlyTokenLimit", "월 토큰 한도", (n: number) => `${n.toLocaleString("en-US")}개`, BUDGET_LIMITS.tokens],
        ] as const;
        for (const [key, name, show, max] of fields) {
          const raw = c[key];
          if (raw === undefined) continue;
          const v = raw === null ? 0 : raw;
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
            problems.push(`${acc.label}: ${name}은 0에서 ${max.toLocaleString("en-US")} 사이의 숫자로 적어 주세요. 비워 두면 제한이 없어요.`);
            continue;
          }
          const value = key === "monthlyTokenLimit" ? Math.round(v) : Math.round(v * 100) / 100;
          const prev = acc[key] ?? 0;
          if (value === prev) continue;
          if (value > 0) setScalar(accounts, ["accounts", id, key], value);
          else accounts.deleteIn(["accounts", id, key]);
          dirty.add("accounts");
          sentences.push(`${acc.label}의 ${name}: ${prev ? show(prev) : "없음"} → ${value ? show(value) : "없음"}`);
        }
      }
  }

  // 지운 모델은 모든 작업 순서에서 뺀다. 순서가 비거나 다른 곳에서 쓰고 있으면 알려 준다.
  if (removed.size) {
    for (const [t, name] of TASK_TYPE_NAMES) {
      const chain = ((routing.getIn(["taskTypes", t]) as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? []) as string[];
      const next = chain.filter((a) => !removed.has(a));
      if (next.length === chain.length) continue;
      if (!next.length) problems.push(`${name} 작업에 쓸 AI가 하나도 남지 않아요. 다른 AI를 먼저 1순위로 골라 주세요.`);
      else {
        setList(routing, ["taskTypes", t], next);
        dirty.add("routing");
      }
    }
    const highRisk = (routing.get("highRiskAlias") as string | undefined) ?? r.highRiskAlias;
    if (removed.has(highRisk)) problems.push(`${label(highRisk)}은(는) '위험한 작업에 먼저 쓸 AI'로 쓰고 있어요. 다른 AI로 바꾼 뒤 지워 주세요.`);
    const planner = (routing.getIn(["planning", "planner"]) as string | undefined) ?? r.planning.planner;
    if (removed.has(planner)) problems.push(`${label(planner)}은(는) '작업을 나눌 AI'로 쓰고 있어요. 다른 AI로 바꾼 뒤 지워 주세요.`);
  }

  sentences.push(...aliasSentences);
  return { sentences, problems, dirty };
}

/** accounts.yaml에 계정을 추가한다. */
export function addAccountToDoc(doc: Document, id: string, value: { engine: string; provider: string; label: string }): void {
  let map = doc.get("accounts", true);
  if (!isMap(map)) {
    doc.set("accounts", doc.createNode({}));
    map = doc.get("accounts", true);
  }
  if (isMap(map)) map.flow = false;
  const node = doc.createNode({ engine: value.engine, provider: value.provider, label: value.label });
  const labelNode = node.get("label", true);
  if (isScalar(labelNode)) labelNode.type = Scalar.QUOTE_DOUBLE;
  doc.setIn(["accounts", id], node);
}

export function removeAccountFromDoc(doc: Document, id: string): void {
  doc.deleteIn(["accounts", id]);
  const map = doc.get("accounts", true);
  if (isMap(map) && map.items.length === 0) map.flow = true;
}

// ---- 파일 쓰기와 백업 ----

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // Windows에서 다른 프로그램이 파일을 열고 있으면 rename이 막힐 수 있다.
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

export function writeFiles(configDir: string, loaded: LoadedFiles, keys: Iterable<FileKey>): void {
  for (const key of keys) writeAtomic(path.join(configDir, CONFIG_FILES[key]), serialize(loaded.docs[key], loaded.eol[key]));
}

function backupsRoot(configDir: string): string {
  return path.join(configDir, "backups");
}

export function listBackups(configDir: string): string[] {
  const root = backupsRoot(configDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => /^\d{4}-\d\d-\d\dT[\d-]+Z(-\d+)?$/.test(n) && statSync(path.join(root, n)).isDirectory())
    .sort();
}

/** 지금 파일 세 개를 backups/<시각>/에 복사하고, 오래된 백업은 최근 20개만 남긴다. */
export function createBackup(configDir: string): string {
  const root = backupsRoot(configDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let name = stamp;
  for (let i = 1; existsSync(path.join(root, name)); i++) name = `${stamp}-${i}`;
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const file of Object.values(CONFIG_FILES)) {
    const src = path.join(configDir, file);
    if (existsSync(src)) copyFileSync(src, path.join(dir, file));
  }
  const all = listBackups(configDir);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) rmSync(path.join(root, old), { recursive: true, force: true });
  return dir;
}

export type RollbackResult = { ok: true; backup: string } | { ok: false; status: number; error: string; problems?: string[] };

/** 가장 최근 백업으로 되돌리고, 쓴 백업은 지운다. 그래서 여러 번 누르면 더 이전으로 돌아간다. */
export function rollback(configDir: string, accountsDir: string): RollbackResult {
  const backups = listBackups(configDir);
  const newest = backups[backups.length - 1];
  if (!newest) return { ok: false, status: 404, error: "되돌릴 이전 설정이 없어요. 저장한 적이 있어야 되돌릴 수 있어요." };
  const dir = path.join(backupsRoot(configDir), newest);
  const docs = {} as Record<FileKey, Document>;
  const texts = {} as Partial<Record<FileKey, string>>;
  for (const key of FILE_KEYS) {
    const src = path.join(dir, CONFIG_FILES[key]);
    const fallback = path.join(configDir, CONFIG_FILES[key]);
    const file = existsSync(src) ? src : fallback;
    const text = existsSync(file) ? readFileSync(file, "utf8").replace(/^﻿/, "") : "";
    if (existsSync(src)) texts[key] = readFileSync(src, "utf8");
    docs[key] = parseDocument(text);
    if (docs[key].errors.length) return { ok: false, status: 400, error: "이전 설정 파일이 깨져 있어 되돌리지 못했어요." };
  }
  const result = check({ docs, eol: { models: "\n", routing: "\n", accounts: "\n" } }, accountsDir);
  if (!result.config) return { ok: false, status: 400, error: "이전 설정에 문제가 있어 되돌리지 못했어요.", problems: result.problems };
  for (const key of FILE_KEYS) {
    const text = texts[key];
    if (text !== undefined) writeAtomic(path.join(configDir, CONFIG_FILES[key]), text);
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, backup: newest };
}
