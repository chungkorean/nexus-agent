import { describe, expect, it } from "vitest";
import { aliasNameFor, parseAgyModels, parseOpencodeModels, PROVIDER_LABELS } from "./catalog.ts";

const SAMPLE = `deepseek/deepseek-flash
{
  "id": "deepseek-flash",
  "providerID": "deepseek",
  "name": "DeepSeek V4.1 Flash",
  "cost": { "input": 0.15, "output": 0.6, "cache": { "read": 0.003, "write": 0 } },
  "limit": { "context": 1000000, "output": 393216 },
  "status": "active"
}
xiaomi/mimo-v2-old
{
  "name": "MiMo old",
  "status": "deprecated"
}
google/gemini-3-pro
`;

describe("parseOpencodeModels", () => {
  it("reads ids, names, cost and context, and skips deprecated models", () => {
    expect(parseOpencodeModels(SAMPLE)).toEqual([
      { engine: "opencode", provider: "deepseek", id: "deepseek/deepseek-flash", name: "DeepSeek V4.1 Flash", context: 1000000, cost: { input: 0.15, output: 0.6 } },
      { engine: "opencode", provider: "google", id: "google/gemini-3-pro", name: "gemini-3-pro" },
    ]);
  });
});

describe("aliasNameFor", () => {
  it("makes a short unique alias name from a model id", () => {
    expect(aliasNameFor("deepseek/deepseek-flash", [])).toBe("deepseek-flash");
    expect(aliasNameFor("deepseek/deepseek-flash", ["deepseek-flash"])).toBe("deepseek-flash-2");
    expect(aliasNameFor("amazon-bedrock/amazon.nova-pro-v1:0", [])).toBe("amazon-nova-pro-v1-0");
    expect(aliasNameFor("claude-opus-5-5", [])).toBe("claude-opus-5-5");
  });
});

describe("agy models 읽기", () => {
  it("slug와 표시 이름을 읽고, 안내 문구는 건너뛴다", () => {
    const text = "Available models:\n\x1b[1mgemini-3.8-flash-high\x1b[0m     Gemini 3.8 Flash (High)\ngemini-3.1-pro-high       Gemini 3.1 Pro (High)\ngemini-3.7-flash-medium\n...\n";
    expect(parseAgyModels(text)).toEqual([
      { engine: "antigravity", provider: "antigravity", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { engine: "antigravity", provider: "antigravity", id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { engine: "antigravity", provider: "antigravity", id: "gemini-3.7-flash-medium", name: "gemini-3.7-flash-medium" },
    ]);
    expect(PROVIDER_LABELS.meta).toBe("Meta Muse");
  });
});
