import type { Classification, NexusConfig, Route } from "@nexus/shared";

/**
 * 분류 결과에 맞는 별칭 대체 순서를 만든다. 앞에서부터 시도하고,
 * 공급자 오류(한도 초과, 로그인 만료 등)가 나면 다음 별칭으로 넘어간다.
 */
export function planRoutes(c: Classification, config: NexusConfig): Route[] {
  const { routing, aliases } = config;
  const chain = [...routing.taskTypes[c.taskType]];

  if (c.risk === "high") chain.unshift(routing.highRiskAlias);
  if (routing.preferLocal && aliases.local && routing.lightTaskTypes.includes(c.taskType) && c.risk !== "high") {
    chain.unshift("local");
  }

  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const name of chain) {
    if (seen.has(name)) continue;
    seen.add(name);
    const a = aliases[name];
    if (!a) continue;
    routes.push({ alias: name, engine: a.engine, model: a.model, accountDir: a.accountDir });
  }
  return routes.slice(0, routing.maxFallbacks + 1);
}
