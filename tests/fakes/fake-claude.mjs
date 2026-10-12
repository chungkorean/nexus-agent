#!/usr/bin/env node
// 테스트용 가짜 claude CLI. `claude -p --output-format json ...`를 흉내 낸다.
// FAKE_CLAUDE_MODE=ok|quota|auth, FAKE_CLAUDE_LOG=받은 호출을 기록할 파일
// FAKE_CLAUDE_PLAN=작업 분해 요청에 돌려줄 JSON, FAKE_CLAUDE_DELAY_MS=작업마다 기다릴 시간
// FAKE_CLAUDE_QUOTA_DIRS=한도에 걸린 것처럼 굴 CLAUDE_CONFIG_DIR 목록(쉼표)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
if (stdin.includes("## Nexus 병합 충돌 해결 요청") && process.env.FAKE_RESOLVE !== "fail") {
  // 충돌 표시를 지우고 양쪽 내용을 모두 남긴다.
  const files = (stdin.match(/충돌 파일: (.+)/)?.[1] ?? "").split(", ").filter(Boolean);
  for (const f of files) {
    const p = path.join(process.cwd(), f);
    writeFileSync(p, readFileSync(p, "utf8").split("\n").filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join("\n"));
  }
  reply("충돌 파일의 양쪽 내용을 모두 살렸어요.");
}
if (stdin.includes("## Nexus 전체 변경 검토 요청")) reply(`판정: ${process.env.FAKE_REVIEW_VERDICT ?? "문제 없음"}\n- 가짜 Claude 검토 의견`);
const key = stdin.match(/하위 작업 키: (\S+)/)?.[1];
const out = process.env.FAKE_SHARED_FILE && key ? process.env.FAKE_SHARED_FILE : key ? `${key}.txt` : "claude-output.txt";
if (!args.includes("--disallowedTools") && !stdin.includes("## Nexus 병합 충돌 해결 요청")) writeFileSync(path.join(process.cwd(), out), `made by fake claude ${model}${key ? ` for ${key}` : ""}\n`);
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

function reply(result) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "s-456", total_cost_usd: 0.002, usage: { input_tokens: 30, output_tokens: 10 } }));
  process.exit(0);
}
