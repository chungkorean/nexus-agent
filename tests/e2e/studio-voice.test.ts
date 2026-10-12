import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveRun, writeTelegramSettings } from "@nexus/shared";
import { createSettingsServer, type SettingsServer } from "../../apps/nexus-server/src/server.ts";
import { detectIntent } from "../../apps/nexus-server/src/assistant.ts";
import { cleanTranscript, parseSenseVoice } from "../../apps/nexus-server/src/voice.ts";
import { FakePaperclip } from "../fakes/fake-paperclip.ts";
import { FAKE_TOKEN, FakeTelegram } from "../fakes/fake-telegram.ts";

const REPO_CONFIG = path.resolve(import.meta.dirname, "../../config");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(40).fill(7)]);
const ME = 4242;

let paperclip: FakePaperclip;
let tg: FakeTelegram;
let tmp: string;
let stateDir: string;
let srv: SettingsServer;
let base: string;
let argsFile: string;

/** 가짜 Whisper: 44바이트 머리 뒤에 적힌 글을 그대로 "알아들은 말"로 돌려준다. */
function fakeWhisper(dir: string): string[] {
  const script = path.join(dir, "fake-whisper.mjs");
  argsFile = path.join(dir, "whisper-args.json");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const buf = readFileSync(args[args.indexOf("-f") + 1]);
console.log(" " + buf.subarray(44).toString("utf8").trim());`,
  );
  return [process.execPath, script];
}

/** 가짜 sherpa-onnx-offline: 결과를 stderr에 JSON 한 줄로 쓴다(실제 프로그램과 같은 모양). */
let senseArgsFile: string;
function fakeSense(dir: string): string[] {
  const script = path.join(dir, "fake-sense.mjs");
  senseArgsFile = path.join(dir, "sense-args.json");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(senseArgsFile)}, JSON.stringify(args));
const text = readFileSync(args.at(-1)).subarray(44).toString("utf8").trim();
console.error("OfflineRecognizerConfig(...)\\n" + args.at(-1));
console.error(JSON.stringify({ lang: "<|ko|>", emotion: "<|NEUTRAL|>", event: "<|Speech|>", text, timestamps: [] }));
console.error("----\\nnum threads: 2");`,
  );
  return [process.execPath, script];
}

function wav(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.alloc(44), body, Buffer.alloc(Math.max(0, 1200 - body.length), 0x20)]);
}

async function post(p: string, body: unknown) {
  const res = await fetch(new URL(p, base), { method: "POST", headers: { "content-type": "application/json", "x-nexus": "1" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
async function get(p: string) {
  const res = await fetch(new URL(p, base));
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  paperclip = new FakePaperclip();
  await paperclip.start();
  tg = new FakeTelegram();
  await tg.start();
});
afterAll(async () => {
  await tg.stop();
  await paperclip.stop();
});

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-sv-"));
  stateDir = path.join(tmp, "state");
  paperclip.created.length = 0;
  paperclip.comments.length = 0;
  paperclip.issues.clear();
  tg.sent.length = 0;
  srv = createSettingsServer({
    configDir: path.join(tmp, "config"),
    fallbackDir: REPO_CONFIG,
    stateDir,
    accountsDir: path.join(tmp, "accounts"),
    port: 0,
    whisperCommand: fakeWhisper(tmp),
    senseVoiceCommand: fakeSense(tmp),
    telegram: { paperclipUrl: paperclip.url, apiBase: tg.url, pollSeconds: 1 },
  });
  base = await srv.listen();
});
afterEach(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("스튜디오", () => {
  it("작업 기록을 보여 주고, 미디어를 내려 주고, 이어서 맡기고, 지운다", async () => {
    const work = path.join(tmp, "work");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(work);
    writeFileSync(path.join(work, "hero.png"), PNG);
    writeFileSync(path.join(work, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const rec = await archiveRun(stateDir, {
      issue: { id: "iss-9", identifier: "NEX-9", title: "주인공 콘셉트 그림" },
      body: "### Nexus 실행 결과: 완료\n\n그림을 만들었어요.",
      cwd: work,
      models: ["google/gemini-3-pro"],
      media: [{ root: work, files: ["hero.png", "logo.svg"] }],
    });

    const list = await get("/api/archive?media=1");
    expect(list.body.items.map((i: any) => i.identifier)).toEqual(["NEX-9"]);
    expect((await get("/api/archive?q=없는말")).body.items).toEqual([]);

    const item = await get(`/api/archive/item?id=${rec.id}`);
    expect(item.body.result).toContain("그림을 만들었어요");
    expect((await get("/api/archive/item?id=..%2Fx")).status).toBe(400);

    const img = await fetch(new URL(`/api/archive/media?id=${rec.id}&name=hero.png`, base));
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    const part = await fetch(new URL(`/api/archive/media?id=${rec.id}&name=hero.png`, base), { headers: { range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-7/${PNG.length}`);
    const svg = await fetch(new URL(`/api/archive/media?id=${rec.id}&name=logo.svg`, base));
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect((await fetch(new URL(`/api/archive/media?id=${rec.id}&name=run.json`, base))).status).toBe(404);

    const cont = await post("/api/archive/continue", { id: rec.id, text: "배경을 밤으로 바꿔 줘" });
    expect(cont.status).toBe(200);
    expect(paperclip.comments.at(-1)).toMatchObject({ issueId: "iss-9", reopen: true });
    expect(paperclip.comments.at(-1)!.body).toContain("배경을 밤으로 바꿔 줘");

    expect((await post("/api/archive/remove", { id: rec.id })).status).toBe(200);
    expect((await get("/api/archive")).body.items).toEqual([]);

    for (const page of ["/studio", "/voice"]) {
      const res = await fetch(new URL(page, base));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});

describe("음성 비서", () => {
  it("말을 글로 바꾸고, 할 일은 이슈로 만들고, 진행 상황을 알려 준다", async () => {
    let v = await get("/api/voice");
    expect(v.body.setup.ready).toBe(true);
    expect(v.body.settings).toMatchObject({ wakeWord: "넥서스", language: "ko", speak: true });
    expect(v.body.companies).toEqual([{ id: "co-1", name: "내 회사" }]);
    expect(v.body.whisperModels.map((m: any) => m.id)).toContain("small-q5_1");
    if (process.platform !== "win32") {
      const ff = await post("/api/voice/install-ffmpeg", {});
      expect(ff.status).toBe(400);
      expect(ff.body.error).toContain("Windows에서만");
    }

    const heard = await fetch(new URL("/api/voice/transcribe", base), { method: "POST", headers: { "content-type": "audio/wav", "x-nexus": "1" }, body: new Uint8Array(wav("넥서스 진행 상황 알려 줘 [음악]")) });
    expect(((await heard.json()) as any).text).toBe("넥서스 진행 상황 알려 줘");
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2)).toEqual(["-l", "ko"]);
    expect(args.at(-1)).toBe("넥서스");
    const noHeader = await fetch(new URL("/api/voice/transcribe", base), { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(wav("x")) });
    expect(noHeader.status).toBe(403);

    // 맡길 곳을 고르기 전에는 안내한다.
    let r = await post("/api/voice/command", { text: "로그인 화면에 비밀번호 찾기 추가해 줘" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("일 맡길 곳");

    v = await post("/api/voice/settings", { companyId: "co-1", agentId: "agent-dev", wakeWord: "자비스", speak: false });
    expect(v.body.settings).toMatchObject({ companyId: "co-1", agentId: "agent-dev", wakeWord: "자비스", speak: false });
    expect((await post("/api/voice/settings", { wakeWord: "a" })).status).toBe(400);

    r = await post("/api/voice/command", { text: "로그인 화면에 비밀번호 찾기 추가해 줘" });
    const task = r.body.reply;
    expect(r.body.reply).toMatchObject({ intent: "task", issue: { identifier: "NEX-101" } });
    expect(paperclip.created[0]).toMatchObject({ companyId: "co-1", input: { title: "로그인 화면에 비밀번호 찾기 추가해 줘", assigneeAgentId: "agent-dev", status: "todo" } });
    expect(paperclip.created[0]!.input.description).toContain("음성으로 보냄");

    r = await post("/api/voice/command", { text: "진행 상황 알려 줘" });
    expect(r.body.reply.intent).toBe("briefing");
    expect(r.body.reply.text).toContain("기다리는 일 1개: NEX-101");

    expect((await post("/api/voice/cancel", { issueId: task.issue.id })).status).toBe(200);
    expect(paperclip.issues.get("iss-child-1")!.status).toBe("cancelled");

    r = await post("/api/voice/command", { text: "이번 달 사용량 알려 줘" });
    expect(r.body.reply.intent).toBe("usage");
    expect(r.body.reply.text).toContain("이번 달 사용량");
  });

  it("스튜디오 채팅으로 맡긴 일이 Paperclip 이슈가 되고, Paperclip 화면을 메뉴 안에 띄운다", async () => {
    let r = await post("/api/chat", { text: "랜딩 페이지 첫 화면 그림 시안 만들어 줘" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("맡길 곳");

    const intake = await get("/api/intake?companyId=co-1");
    expect(intake.body.companies[0]).toMatchObject({ id: "co-1" });
    expect(intake.body.agents.length).toBeGreaterThan(0);
    await post("/api/voice/settings", { companyId: "co-1", agentId: "agent-dev" });
    expect((await get("/api/intake")).body).toMatchObject({ companyId: "co-1", agentId: "agent-dev" });

    r = await post("/api/chat", { text: "랜딩 페이지 첫 화면 그림 시안 만들어 줘\n세 가지로, 밝은 색으로" });
    expect(r.body.reply).toMatchObject({ intent: "task", issue: { identifier: "NEX-101" } });
    expect(paperclip.created[0]).toMatchObject({ companyId: "co-1", input: { title: "랜딩 페이지 첫 화면 그림 시안 만들어 줘", assigneeAgentId: "agent-dev" } });
    expect(paperclip.created[0]!.input.description).toContain("세 가지로");
    expect(paperclip.created[0]!.input.description).toContain("Nexus 스튜디오에서 보냄");
    expect((await post("/api/chat", { text: "  " })).status).toBe(400);

    expect((await get("/api/paperclip")).body).toMatchObject({ url: paperclip.url, up: true });
    const page = await fetch(new URL("/paperclip", base));
    expect(page.status).toBe(200);
    const port = new URL(paperclip.url).port;
    expect(page.headers.get("content-security-policy")).toContain(`frame-src http://127.0.0.1:${port} http://localhost:${port};`);
  });

  it("SenseVoice 엔진으로 바꿔 받아쓴다", async () => {
    let v = await post("/api/voice/settings", { engine: "sensevoice", language: "ko" });
    expect(v.body.settings.engine).toBe("sensevoice");
    expect(v.body.setup.engines).toEqual({ whisper: true, sensevoice: true });
    expect((await post("/api/voice/settings", { engine: "siri" })).status).toBe(400);
    const res = await fetch(new URL("/api/voice/transcribe", base), { method: "POST", headers: { "content-type": "audio/wav", "x-nexus": "1" }, body: new Uint8Array(wav("넥서스 오늘 브리핑 해 줘")) });
    expect(((await res.json()) as any).text).toBe("넥서스 오늘 브리핑 해 줘");
    const args = JSON.parse(readFileSync(senseArgsFile, "utf8")) as string[];
    expect(args).toEqual(expect.arrayContaining(["--sense-voice-language=ko", "--sense-voice-use-itn=1"]));
    if (process.platform !== "win32") expect((await post("/api/voice/install-sensevoice", {})).status).toBe(400);
  });

  it("텔레그램 음성 메시지를 글로 바꿔 할 일로 등록한다", async () => {
    writeTelegramSettings(stateDir, { enabled: true, notifyResults: true, botToken: FAKE_TOKEN, chats: [{ id: ME, name: "정" }], companyId: "co-1", agentId: "agent-dev" });
    tg.files.set("voice-1", { path: "voice/file_1.oga", data: wav("검색 기능 구현해 줘") });
    // 시험에서는 OGG 대신 WAV를 쓰므로 오디오 파일로 보낸다.
    tg.push(ME, "", { text: undefined, audio: { file_id: "voice-1", mime_type: "audio/wav", file_name: "memo.wav" } });
    await tg.waitFor(() => paperclip.created.length === 1);
    expect(paperclip.created[0]!.input.title).toBe("검색 기능 구현해 줘");
    expect(tg.sent.some((m) => m.text.includes("🎤 들은 말: 검색 기능 구현해 줘"))).toBe(true);

    tg.push(ME, "/status");
    await tg.waitFor(() => tg.sent.some((m) => m.text.includes("오늘 끝난 작업")));
  });

  it("명령과 할 일을 구분하고 Whisper의 지어낸 말을 걸러 낸다", () => {
    expect(detectIntent("진행 상황 알려 줘")).toBe("briefing");
    expect(detectIntent("오늘 브리핑 해 줘")).toBe("briefing");
    expect(detectIntent("사용량 얼마나 썼어")).toBe("usage");
    expect(detectIntent("도움말")).toBe("help");
    expect(detectIntent("검색 기능 진행 상황을 보여 주는 대시보드 페이지를 새로 만들고 관리자만 볼 수 있게 해 줘")).toBe("task");
    expect(cleanTranscript(" 시청해 주셔서 감사합니다.")).toBe("");
    expect(parseSenseVoice('a.wav\n{"lang": "<|ko|>", "text": "안녕 <|ko|>하세요", "tokens": []}\n----')).toBe("안녕 하세요");
    expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  넥서스 (웃음) 안녕")).toBe("넥서스 안녕");
  });
});
