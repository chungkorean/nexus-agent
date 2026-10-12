// 설정 화면의 "사용량" 칸: usage.jsonl 기록을 계정·모델·작업 종류별로 합치고, 기록으로 본 순서 조정 제안을 만든다.
import {
  budgetExceeded,
  budgetOf,
  emptyTotals,
  groupTotals,
  monthStart,
  readUsage,
  type NexusConfig,
  type UsageEntry,
  type UsageTotals,
} from "@nexus/shared";
import { TASK_TYPE_NAMES } from "./store.ts";

export const USAGE_PERIODS = ["today", "7d", "30d", "month"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** 제안을 내려면 그 모델이 그 작업을 몇 번 이상 해 봤어야 하는지 */
export const HINT_MIN_RUNS = 5;
const HINT_LOW_RATE = 0.6;
const HINT_GOOD_RATE = 0.8;
const HINT_MIN_RUNS_OTHER = 3;

const PURPOSE_NAMES: Record<string, string> = {
  ...Object.fromEntries(TASK_TYPE_NAMES),
  plan: "작업 나누기",
  conflict: "충돌 해결",
  review: "검토",
};

export function periodStart(period: UsagePeriod, now: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (period === "today") return today;
  if (period === "7d") return today - 6 * 86_400_000;
  if (period === "30d") return today - 29 * 86_400_000;
  return monthStart(now);
}

export interface UsageHint {
  purpose: string;
  alias: string;
  better: string;
  text: string;
}

export function usageReport(config: NexusConfig, stateDir: string, period: UsagePeriod, now = Date.now()) {
  const since = periodStart(period, now);
  const month = monthStart(now);
  const entries = readUsage(stateDir, Math.min(since, month));
  const inPeriod = entries.filter((e) => Date.parse(e.at) >= since);
  const inMonth = entries.filter((e) => Date.parse(e.at) >= month);
  const aliasLabel = (name: string) => config.aliases[name]?.label ?? name;

  const byAccount = groupTotals(inPeriod, (e) => e.accountId ?? "");
  const monthByAccount = groupTotals(inMonth, (e) => e.accountId ?? "");
  const accountIds = new Set([...Object.keys(config.accounts), ...Object.keys(byAccount)]);
  const accounts = [...accountIds]
    .map((id) => {
      const acc = id ? config.accounts[id] : undefined;
      const budget = budgetOf(acc);
      const used = monthByAccount[id] ?? emptyTotals();
      return {
        id,
        label: id ? (acc?.label ?? `${id} (지운 계정)`) : "평소 로그인한 계정",
        provider: acc?.provider ?? "",
        totals: byAccount[id] ?? emptyTotals(),
        budget: budget
          ? {
              monthlyBudgetUsd: budget.monthlyBudgetUsd ?? null,
              monthlyTokenLimit: budget.monthlyTokenLimit ?? null,
              usedUsd: round(used.costUsd),
              usedTokens: used.inputTokens + used.outputTokens,
              exceeded: budgetExceeded(budget, used),
            }
          : null,
      };
    })
    .filter((a) => a.id || a.totals.runs > 0)
    .sort((a, b) => b.totals.runs - a.totals.runs || a.label.localeCompare(b.label));

  const byModel = groupTotals(inPeriod, (e) => `${e.alias}\u0000${e.model}`);
  const models = Object.entries(byModel)
    .map(([key, totals]) => {
      const [alias, model] = key.split("\u0000") as [string, string];
      return { alias, label: aliasLabel(alias), model, totals: roundTotals(totals) };
    })
    .sort((a, b) => b.totals.runs - a.totals.runs);

  return {
    period,
    since: new Date(since).toISOString(),
    totals: roundTotals(groupTotals(inPeriod, () => "all").all ?? emptyTotals()),
    accounts: accounts.map((a) => ({ ...a, totals: roundTotals(a.totals) })),
    models,
    hints: usageHints(inPeriod, config),
    recent: inPeriod.slice(-20).reverse().map((e) => ({ ...e, aliasLabel: aliasLabel(e.alias), accountLabel: e.accountId ? (config.accounts[e.accountId]?.label ?? e.accountId) : "" })),
  };
}

/**
 * 기록으로 본 순서 조정 제안. 같은 작업 종류에서 어떤 모델이 자주 실패하고
 * 다른 모델은 잘 해냈다면, 그 모델을 1순위로 올려 보라고 알려 준다. 자동으로 바꾸지는 않는다.
 * 한도·로그인 같은 공급자 오류는 모델 실력과 상관없어서 세지 않는다.
 */
export function usageHints(entries: UsageEntry[], config: NexusConfig): UsageHint[] {
  const relevant = entries.filter((e) => e.purpose && (e.ok || e.errorFamily === "task_failed" || e.errorFamily === "timeout"));
  const groups = groupTotals(relevant, (e) => `${e.purpose}\u0000${e.alias}`);
  const byPurpose: Record<string, Array<{ alias: string; t: UsageTotals }>> = {};
  for (const [key, t] of Object.entries(groups)) {
    const [purpose, alias] = key.split("\u0000") as [string, string];
    (byPurpose[purpose] ??= []).push({ alias, t });
  }
  const label = (a: string) => config.aliases[a]?.label ?? a;
  const hints: UsageHint[] = [];
  for (const [purpose, rows] of Object.entries(byPurpose)) {
    const rate = (t: UsageTotals) => t.ok / t.runs;
    for (const weak of rows) {
      if (weak.t.runs < HINT_MIN_RUNS || rate(weak.t) >= HINT_LOW_RATE) continue;
      const better = rows
        .filter((r) => r.alias !== weak.alias && r.t.runs >= HINT_MIN_RUNS_OTHER && rate(r.t) >= HINT_GOOD_RATE && config.aliases[r.alias])
        .sort((a, b) => rate(b.t) - rate(a.t) || b.t.runs - a.t.runs)[0];
      if (!better) continue;
      const name = PURPOSE_NAMES[purpose] ?? purpose;
      hints.push({
        purpose,
        alias: weak.alias,
        better: better.alias,
        text: `${name} 작업에서 ${label(weak.alias)}의 성공률이 ${pct(rate(weak.t))}예요 (${weak.t.runs}번 중 ${weak.t.ok}번). ${label(better.alias)}는 ${pct(rate(better.t))}예요 (${better.t.runs}번). '작업별 담당 AI'에서 ${name} 작업의 1순위를 ${label(better.alias)}로 바꿔 보세요.`,
      });
    }
  }
  return hints;
}

function roundTotals(t: UsageTotals): UsageTotals {
  return { ...t, costUsd: round(t.costUsd) };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
