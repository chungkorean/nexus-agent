import type { ServerAdapterModule } from "../adapter-types.ts";
import { agentConfigurationDoc, models } from "../meta.ts";
import { ADAPTER_TYPE } from "../settings.ts";
import { executeDispatch } from "./execute.ts";
import { testDispatchEnvironment } from "./test.ts";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute: (ctx) => executeDispatch(ctx),
    testEnvironment: (ctx) => testDispatchEnvironment(ctx),
    models,
    agentConfigurationDoc,
  };
}
