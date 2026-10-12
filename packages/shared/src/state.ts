import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Account, ErrorFamily } from "./types.ts";
import { addTotals, appendUsage, budgetExceeded, budgetOf, emptyTotals, monthStart, readUsage, type Budget, type UsageEntry, type UsageTotals } from "./usage.ts";

export interface AccountCooldown {
  /** ISO 시각. 이 시각까지는 이 계정을 건너뛴다. */
  until: string;
  reason: ErrorFamily;
  message?: string;
}

/** 공급자 오류 종류별로 계정을 쉬게 하는 시간(분). 로그인 만료는 다시 로그인할 때까지 오래 쉰다. */
export const COOLDOWN_MINUTES: Partial<Record<ErrorFamily, number>> = {
  provider_quota: 60,
  provider_auth: 12 * 60,
  provider_unavailable: 5,
};

/**
 * 계정별 한도·로그인 상태를 state 폴더의 accounts-state.json에 남긴다.
 * 병렬 실행 중에도 같은 객체를 쓰므로 한 실행 안에서는 즉시 반영되고,
 * 다음 실행과 설정 화면은 파일로 같은 상태를 본다.
 */
export class AccountState {
  private data: Record<string, AccountCooldown>;
  private readonly file: string;
  private budgets: Record<string, Budget> = {};
  /** 예산이 있는 계정의 이번 달 사용량. setBudgets에서 읽고 record로 늘린다. */
  private monthUsage: Record<string, UsageTotals> = {};
  private month = 0;

  constructor(
    private readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(stateDir, "accounts-state.json");
    this.data = AccountState.read(this.file);
  }

  /** 계정별 월 예산을 알려 준다. 이번 달 기록을 읽어 이미 쓴 양을 계산한다. */
  setBudgets(accounts: Record<string, Pick<Account, "monthlyBudgetUsd" | "monthlyTokenLimit">>): void {
    this.budgets = {};
    for (const [id, acc] of Object.entries(accounts)) {
      const b = budgetOf(acc);
      if (b) this.budgets[id] = b;
    }
    this.month = monthStart(this.now());
    this.monthUsage = {};
    if (!Object.keys(this.budgets).length) return;
    for (const e of readUsage(this.stateDir, this.month)) {
      if (e.accountId && this.budgets[e.accountId]) addTotals((this.monthUsage[e.accountId] ??= emptyTotals()), e);
    }
  }

  /** 예산을 넘었으면 이유, 아니면 null */
  overBudget(accountId: string): string | null {
    const budget = this.budgets[accountId];
    if (!budget) return null;
    if (monthStart(this.now()) !== this.month) this.setBudgets(this.budgets);
    return budgetExceeded(budget, this.monthUsage[accountId] ?? emptyTotals());
  }

  /** 지금 이 계정을 쓰면 안 되는 이유(한도로 쉬는 중, 예산 초과). 써도 되면 null */
  unavailableReason(accountId: string): string | null {
    const c = this.get(accountId);
    if (c) return `계정이 쉬는 중이에요 (${c.reason})`;
    return this.overBudget(accountId);
  }

  isUnavailable(accountId: string): boolean {
    return this.unavailableReason(accountId) !== null;
  }

  /** 모델을 한 번 부른 기록을 남긴다. */
  record(entry: UsageEntry): void {
    appendUsage(this.stateDir, entry);
    if (entry.accountId && this.budgets[entry.accountId]) addTotals((this.monthUsage[entry.accountId] ??= emptyTotals()), entry);
  }

  static read(file: string): Record<string, AccountCooldown> {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { cooldowns?: Record<string, AccountCooldown> };
      return parsed.cooldowns ?? {};
    } catch {
      return {};
    }
  }

  isCoolingDown(accountId: string): boolean {
    const c = this.data[accountId];
    return !!c && Date.parse(c.until) > this.now();
  }

  get(accountId: string): AccountCooldown | null {
    return this.isCoolingDown(accountId) ? this.data[accountId]! : null;
  }

  all(): Record<string, AccountCooldown> {
    return Object.fromEntries(Object.keys(this.data).filter((id) => this.isCoolingDown(id)).map((id) => [id, this.data[id]!]));
  }

  /** 공급자 오류면 계정을 쉬게 하고 true를 돌려준다. */
  report(accountId: string, family: ErrorFamily | undefined, message?: string): boolean {
    const minutes = family ? COOLDOWN_MINUTES[family] : undefined;
    if (!minutes) return false;
    this.data[accountId] = { until: new Date(this.now() + minutes * 60_000).toISOString(), reason: family!, message: message?.slice(0, 300) };
    this.save();
    return true;
  }

  clear(accountId?: string): void {
    if (accountId) delete this.data[accountId];
    else this.data = {};
    this.save();
  }

  private save(): void {
    try {
      // 다른 실행이 그사이 남긴 상태를 잃지 않게 파일을 다시 읽어 합친다.
      const merged = { ...AccountState.read(this.file), ...this.data };
      for (const id of Object.keys(merged)) if (!(id in this.data)) delete merged[id];
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cooldowns: merged }, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* 상태 파일을 못 써도 실행은 계속한다 */
    }
  }
}

/**
 * 계정 폴더에 로그인해 둔 흔적이 있는지. Claude Code는 .credentials.json, OpenCode는 opencode/auth.json.
 * Ollama 같은 로컬 모델은 로그인이 필요 없다. Antigravity는 로그인 정보를 운영체제 자격 증명 저장소에 두어
 * 파일로 확인할 수 없으므로, 로그인을 한 번 연 적이 있으면(.nexus-login 표시) 된 것으로 본다.
 */
/** Antigravity 계정 폴더에 남기는 "로그인 창을 열었음" 표시 파일 */
export const ANTIGRAVITY_LOGIN_MARK = ".nexus-login";

export function accountHasLogin(account: Account): boolean {
  if (account.provider.toLowerCase() === "ollama") return true;
  if (account.engine === "claude-code") return existsSync(path.join(account.dir, ".credentials.json"));
  if (account.engine === "antigravity") return existsSync(path.join(account.dir, ANTIGRAVITY_LOGIN_MARK));
  return existsSync(path.join(account.dir, "opencode", "auth.json"));
}
