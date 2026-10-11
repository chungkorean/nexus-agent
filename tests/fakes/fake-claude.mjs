#!/usr/bin/env node
// 테스트용 가짜 claude CLI. `claude -p --output-format json ...`를 흉내 낸다.
// FAKE_CLAUDE_MODE=ok|quota|auth, FAKE_CLAUDE_LOG=받은 호출을 기록할 파일
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
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ args, model, cwd: process.cwd(), prompt: stdin, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, hasApiKey: "ANTHROPIC_API_KEY" in process.env }) + "\n",
  );
}
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (mode === "quota" || mode === "auth") {
  const result = mode === "quota" ? "Claude AI usage limit reached|1760000000" : "Invalid API key · Please run /login";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result, session_id: "s-err", total_cost_usd: 0 }));
  process.exit(1);
}
writeFileSync(path.join(process.cwd(), "claude-output.txt"), "made by fake claude\n");
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
