import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ErrorFamily } from "./types.ts";

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

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(stateDir, "accounts-state.json");
    this.data = AccountState.read(this.file);
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
