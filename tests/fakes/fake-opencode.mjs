#!/usr/bin/env node
// 테스트용 가짜 opencode. `serve`만 흉내 낸다.
// FAKE_OPENCODE_MODE=ok|quota, FAKE_OPENCODE_LOG=받은 요청을 기록할 파일
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fake");
  process.exit(0);
}
if (args[0] !== "serve") {
  console.error("fake-opencode: serve만 지원해요");
  process.exit(2);
}
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1";
const expectedAuth = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
const log = (entry) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(entry) + "\n");

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url, `http://${host}`);
  const directory = url.searchParams.get("directory");
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "POST" && url.pathname === "/session") return json(200, { id: "ses_fake1" });
  const msg = url.pathname.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === "POST" && msg) {
    const parsed = JSON.parse(body);
    const text = parsed.parts?.[0]?.text ?? "";
    const isPlan = text.includes("## Nexus 작업 분해 요청");
    const startedAt = Date.now();
    const delay = Number(process.env.FAKE_OPENCODE_DELAY_MS ?? 0);
    if (delay && !isPlan) await new Promise((r) => setTimeout(r, delay));
    log({ kind: "prompt", directory, model: parsed.model, agent: parsed.agent ?? null, text, startedAt, endedAt: Date.now(), env: { XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null, config: process.env.OPENCODE_CONFIG_CONTENT ?? null } });
    if (process.env.FAKE_OPENCODE_MODE === "quota") {
      return json(200, { info: { cost: 0, tokens: { input: 5, output: 0, cache: { read: 0 } }, error: { name: "APIError", data: { message: "rate limit exceeded", statusCode: 429 } } }, parts: [] });
    }
    if (isPlan) {
      return json(200, { info: { cost: 0.001, tokens: { input: 3, output: 2 } }, parts: [{ type: "text", text: "```json\n" + (process.env.FAKE_OPENCODE_PLAN ?? "{}") + "\n```" }] });
    }
    const key = text.match(/하위 작업 키: (\S+)/)?.[1];
    if (!parsed.agent) writeFileSync(path.join(directory, key ? `${key}.txt` : "opencode-output.txt"), "made by fake opencode\n");
    return json(200, {
      info: { cost: 0.0123, tokens: { input: 120, output: 45, cache: { read: 30 } } },
      parts: [{ type: "text", text: "1. 가짜 OpenCode가 파일을 만들었어요.\n2. opencode-output.txt\n3. 확인 없음\n4. 없음" }],
    });
  }
  if (req.method === "GET" && /\/diff$/.test(url.pathname)) {
    return json(200, [{ file: "opencode-output.txt", before: "", after: "made", additions: 1, deletions: 0 }]);
  }
  if (req.method === "POST" && /\/abort$/.test(url.pathname)) return json(200, true);
  json(404, { error: "not found" });
});
server.listen(port, host, () => console.log(`opencode server listening on http://${host}:${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
