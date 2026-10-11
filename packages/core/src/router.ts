import type { Classification, NexusConfig, Route, TaskType } from "@nexus/shared";

export interface RouteOptions {
  /** 한도·로그인 문제로 쉬는 계정이면 true */
  isCoolingDown?: (accountId: string) => boolean;
  /**
   * 같은 별칭의 계정 중 몇 번째부터 쓸지. 병렬 하위 작업마다 다른 값을 주면
   * 같은 모델을 쓰더라도 계정이 고르게 나뉜다.
   */
  spread?: number;
}

/**
 * 분류 결과에 맞는 대체 순서를 만든다. 앞에서부터 시도하고,
 * 공급자 오류(한도 초과, 로그인 만료 등)가 나면 다음으로 넘어간다.
 * 같은 별칭의 다른 계정으로 넘어가는 것은 maxFallbacks에 세지 않는다.
 */
export function planRoutes(c: Pick<Classification, "taskType" | "risk">, config: NexusConfig, opts: RouteOptions = {}): Route[] {
  return expandAliases(aliasChain(c, config), config, opts);
}

/** 작업 종류와 위험도로 별칭 순서를 정한다. */
export function aliasChain(c: Pick<Classification, "taskType" | "risk">, config: NexusConfig): string[] {
  const { routing, aliases } = config;
  const chain = [...routing.taskTypes[c.taskType as TaskType]];
  if (c.risk === "high") chain.unshift(routing.highRiskAlias);
  if (routing.preferLocal && aliases.local && routing.lightTaskTypes.includes(c.taskType) && c.risk !== "high") {
    chain.unshift("local");
  }
  return [...new Set(chain)].filter((a) => aliases[a]).slice(0, routing.maxFallbacks + 1);
}

/** 별칭마다 쓸 수 있는 계정으로 펼친다. 쉬는 계정은 빼고, 모두 쉬면 그 별칭을 건너뛴다. */
export function expandAliases(chain: string[], config: NexusConfig, opts: RouteOptions = {}): Route[] {
  const routes: Route[] = [];
  for (const name of chain) {
    const a = config.aliases[name];
    if (!a) continue;
    if (!a.accounts?.length) {
      routes.push({ alias: name, engine: a.engine, model: a.model, accountDir: a.accountDir });
      continue;
    }
    const n = a.accounts.length;
    const start = ((opts.spread ?? 0) % n + n) % n;
    const ordered = [...a.accounts.slice(start), ...a.accounts.slice(0, start)];
    for (const id of ordered) {
      const acc = config.accounts[id];
      if (!acc || opts.isCoolingDown?.(id)) continue;
      routes.push({ alias: name, engine: a.engine, model: a.model, accountDir: acc.dir, accountId: id, accountLabel: acc.label });
    }
  }
  return routes;
}
