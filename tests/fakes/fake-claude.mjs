#!/usr/bin/env node
// 테스트용 가짜 claude CLI. `claude -p --output-format json ...`를 흉내 낸다.
// FAKE_CLAUDE_MODE=ok|quota|auth, FAKE_CLAUDE_LOG=받은 호출을 기록할 파일
// FAKE_CLAUDE_PLAN=작업 분해 요청에 돌려줄 JSON, FAKE_CLAUDE_DELAY_MS=작업마다 기다릴 시간
// FAKE_CLAUDE_QUOTA_DIRS=한도에 걸린 것처럼 굴 CLAUDE_CONFIG_DIR 목록(쉼표)
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code fake)");
  process.exit(0);
}
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const model = args[args.indexOf("--model") + 1];
const startedAt = Date.now();
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
const isPlan = stdin.includes("## Nexus 작업 분해 요청");
if (delay && !isPlan) await new Promise((r) => setTimeout(r, delay));
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ args, model, cwd: process.cwd(), prompt: stdin, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, hasApiKey: "ANTHROPIC_API_KEY" in process.env, startedAt, endedAt: Date.now() }) + "\n",
  );
}
const quotaDirs = (process.env.FAKE_CLAUDE_QUOTA_DIRS ?? "").split(",").filter(Boolean);
let mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (process.env.CLAUDE_CONFIG_DIR && quotaDirs.includes(process.env.CLAUDE_CONFIG_DIR)) mode = "quota";
if (mode === "quota" || mode === "auth") {
  const result = mode === "quota" ? "Claude AI usage limit reached|1760000000" : "Invalid API key · Please run /login";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result, session_id: "s-err", total_cost_usd: 0 }));
  process.exit(1);
}
if (isPlan) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + (process.env.FAKE_CLAUDE_PLAN ?? "{}") + "\n```", session_id: "s-plan", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
const key = stdin.match(/하위 작업 키: (\S+)/)?.[1];
if (!args.includes("--disallowedTools")) writeFileSync(path.join(process.cwd(), key ? `${key}.txt` : "claude-output.txt"), `made by fake claude ${model}\n`);
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "1. 가짜 Claude가 파일을 만들었어요.\n2. claude-output.txt\n3. 확인 없음\n4. 없음",
    session_id: "s-123",
    total_cost_usd: 0.0456,
    usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
  }),
);
