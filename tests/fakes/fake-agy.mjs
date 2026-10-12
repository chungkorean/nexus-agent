#!/usr/bin/env node
// 테스트용 가짜 agy(Antigravity CLI). `agy -p "<지시문>" --output-format json --model ...`과 `agy models`를 흉내 낸다.
// FAKE_AGY_MODE=ok|quota|auth|badmodel, FAKE_AGY_LOG=받은 호출을 기록할 파일
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.0.0 (agy fake)");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("gemini-3.8-flash-high     Gemini 3.8 Flash (High)");
  console.log("gemini-3.1-pro-high       Gemini 3.1 Pro (High)");
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] ?? "";
const model = args[args.indexOf("--model") + 1];
// 긴 지시문은 파일 경로로 온다. 파일이 있으면 읽는다.
const file = prompt.match(/작업해 주세요: (.+)$/)?.[1];
const full = file ? readFileSync(file, "utf8") : prompt;
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args, model, cwd: process.cwd(), prompt, full }) + "\n");
const mode = process.env.FAKE_AGY_MODE ?? "ok";
const usage = { input_tokens: 120, output_tokens: 30, thinking_tokens: 10, cache_read_tokens: 40, total_tokens: 200 };
if (mode !== "ok") {
  const error = { quota: "RESOURCE_EXHAUSTED: You have reached your usage limit", auth: "Not authenticated. Run agy to sign in.", badmodel: `Unknown model: ${model}` }[mode];
  console.log(JSON.stringify({ response: "", status: "ERROR", error, usage, conversation_id: "c-err" }));
  process.exit(1);
}
if (args.includes("--dangerously-skip-permissions")) writeFileSync(path.join(process.cwd(), "agy-made.txt"), "가짜 agy가 만든 파일\n");
console.log(JSON.stringify({ response: `완료했어요 (${model}, ${full.length}자)`, status: "SUCCESS", error: null, usage, duration_seconds: 1.2, num_turns: 2, conversation_id: "c-1" }));
