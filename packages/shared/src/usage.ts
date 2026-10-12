import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Account, Engine, ErrorFamily } from "./types.ts";

/** 모델을 한 번 부를 때마다 남기는 기록. state 폴더의 usage.jsonl에 한 줄씩 쌓인다. */
export interface UsageEntry {
  /** ISO 시각 */
  at: string;
  issue?: string;
  /** 무엇 때문에 불렀는지: 작업 종류(implement 등) 또는 plan, review, conflict */
  purpose?: string;
  alias: string;
  engine: Engine;
  model: string;
  /** accounts.yaml의 계정 ID. 평소 로그인한 계정이면 비어 있다. */
  accountId?: string;
  ok: boolean;
  errorFamily?: ErrorFamily;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
}

/** 계정의 월 예산. 둘 중 하나라도 넘으면 그달 남은 기간에는 그 계정을 건너뛴다. */
export interface Budget {
  monthlyBudgetUsd?: number;
  monthlyTokenLimit?: number;
}

export interface UsageTotals {
  runs: number;
  ok: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const MAX_READ_BYTES = 20 * 1024 * 1024;

export function usageFile(stateDir: string): string {
  return path.join(stateDir, "usage.jsonl");
}

/** 이번 달 1일 0시(현지 시각) */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function appendUsage(stateDir: string, entry: UsageEntry): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(usageFile(stateDir), JSON.stringify(entry) + "\n");
  } catch {
    /* 기록을 못 남겨도 실행은 계속한다 */
  }
}

/** since(ms) 이후 기록. 파일이 너무 크면 뒤쪽(최근)만 읽는다. */
export function readUsage(stateDir: string, since = 0): UsageEntry[] {
  const file = usageFile(stateDir);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (text.length > MAX_READ_BYTES) text = text.slice(text.indexOf("\n", text.length - MAX_READ_BYTES) + 1);
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (typeof e.at === "string" && Date.parse(e.at) >= since) out.push(e);
    } catch {
      /* 깨진 줄은 건너뛴다 */
    }
  }
  return out;
}

export function emptyTotals(): UsageTotals {
  return { runs: 0, ok: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function addTotals(t: UsageTotals, e: UsageEntry): UsageTotals {
  t.runs += 1;
  if (e.ok) t.ok += 1;
  t.inputTokens += e.inputTokens || 0;
  t.outputTokens += e.outputTokens || 0;
  t.costUsd += e.costUsd || 0;
  return t;
}

/** 기록을 key별로 묶어 합친다. */
export function groupTotals(entries: UsageEntry[], key: (e: UsageEntry) => string): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const e of entries) addTotals((out[key(e)] ??= emptyTotals()), e);
  return out;
}

export function budgetOf(account: Pick<Account, "monthlyBudgetUsd" | "monthlyTokenLimit"> | undefined): Budget | null {
  if (!account) return null;
  const b: Budget = {};
  if (account.monthlyBudgetUsd && account.monthlyBudgetUsd > 0) b.monthlyBudgetUsd = account.monthlyBudgetUsd;
  if (account.monthlyTokenLimit && account.monthlyTokenLimit > 0) b.monthlyTokenLimit = account.monthlyTokenLimit;
  return b.monthlyBudgetUsd || b.monthlyTokenLimit ? b : null;
}

/** 예산을 넘었으면 사람이 읽는 이유, 아니면 null */
export function budgetExceeded(budget: Budget | null, used: UsageTotals): string | null {
  if (!budget) return null;
  if (budget.monthlyBudgetUsd && used.costUsd >= budget.monthlyBudgetUsd) {
    return `이번 달 예산 $${budget.monthlyBudgetUsd}을 다 썼어요 ($${used.costUsd.toFixed(2)})`;
  }
  const tokens = used.inputTokens + used.outputTokens;
  if (budget.monthlyTokenLimit && tokens >= budget.monthlyTokenLimit) {
    return `이번 달 토큰 한도 ${budget.monthlyTokenLimit.toLocaleString("en-US")}개를 다 썼어요 (${tokens.toLocaleString("en-US")}개)`;
  }
  return null;
}
