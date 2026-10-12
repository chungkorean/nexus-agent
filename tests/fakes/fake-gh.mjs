#!/usr/bin/env node
// 테스트용 가짜 GitHub CLI. `gh pr create ...`만 흉내 낸다. FAKE_GH_LOG=받은 호출을 기록할 파일
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const bodyFile = args[args.indexOf("--body-file") + 1];
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, body: bodyFile ? readFileSync(bodyFile, "utf8") : null, cwd: process.cwd() }) + "\n");
if (process.env.FAKE_GH_MODE === "noauth") {
  console.error("To get started with GitHub CLI, please run:  gh auth login");
  process.exit(4);
}
console.log("https://github.com/me/repo/pull/7");
