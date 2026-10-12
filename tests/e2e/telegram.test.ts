import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifyTelegram, readMessageLinks, readTelegramSettings, writeTelegramSettings } from "@nexus/shared";
import { createSettingsServer, type SettingsServer } from "../../apps/nexus-server/src/server.ts";
import { telegramSummary } from "../../packages/paperclip-adapter/src/server/run.ts";
import { FakePaperclip } from "../fakes/fake-paperclip.ts";
import { FAKE_TOKEN, FakeTelegram } from "../fakes/fake-telegram.ts";

const REPO_CONFIG = path.resolve(import.meta.dirname, "../../config");
const ME = 4242;

let paperclip: FakePaperclip;
let tg: FakeTelegram;
let tmp: string;
let stateDir: string;
let srv: SettingsServer;
let base: string;

async function post(p: string, body: unknown) {
  const res = await fetch(new URL(p, base), { method: "POST", headers: { "content-type": "application/json", "x-nexus": "1" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
async function get(p: string) {
  return (await (await fetch(new URL(p, base))).json()) as any;
}
const lastTo = (chat: number) => [...tg.sent].reverse().find((m) => m.chat_id === chat)?.text ?? "";

beforeAll(async () => {
  paperclip = new FakePaperclip();
  await paperclip.start();
  tg = new FakeTelegram();
  await tg.start();
  process.env.NEXUS_TELEGRAM_API = tg.url;
});
afterAll(async () => {
  delete process.env.NEXUS_TELEGRAM_API;
  await tg.stop();
  await paperclip.stop();
});

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-tg-"));
  stateDir = path.join(tmp, "state");
  tg.sent.length = 0;
  paperclip.created.length = 0;
  paperclip.comments.length = 0;
  srv = createSettingsServer({
    configDir: path.join(tmp, "config"),
    fallbackDir: REPO_CONFIG,
    stateDir,
    accountsDir: path.join(tmp, "accounts"),
    port: 0,
    telegram: { paperclipUrl: paperclip.url, apiBase: tg.url, pollSeconds: 1 },
  });
  base = await srv.listen();
});
afterEach(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("텔레그램", () => {
  it("토큰을 확인하고, 연결 코드로 짝지은 대화방의 메시지만 이슈로 등록한다", async () => {
    expect((await post("/api/telegram/token", { token: "nope" })).status).toBe(400);
    expect((await post("/api/telegram/token", { token: "123456789:AAHwrongTokenButRightShape_abcdefghij" })).status).toBe(400);
    const saved = await post("/api/telegram/token", { token: FAKE_TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body.message).toContain("@nexus_test_bot");

    let state = await get("/api/telegram");
    expect(state).toMatchObject({ hasToken: true, botName: "@nexus_test_bot", chats: [], companies: [{ id: "co-1", name: "내 회사" }] });
    expect(state.agents.map((a: any) => a.id)).toEqual(["agent-dev", "agent-hermes"]);
    expect(JSON.stringify(state)).not.toContain(FAKE_TOKEN);

    // 연결 전에는 할 일을 받지 않는다.
    tg.push(ME, "검색 기능 구현");
    await tg.waitFor(() => lastTo(ME).includes("주인만"));

    const { body: pair } = await post("/api/telegram/pair", {});
    expect(pair.code).toMatch(/^\d{6}$/);
    tg.push(ME, pair.code === "000000" ? "111111" : "000000");
    await tg.waitFor(() => lastTo(ME).includes("맞지 않아요"));
    tg.push(ME, `/start ${pair.code}`);
    await tg.waitFor(() => lastTo(ME).includes("연결했어요"));
    state = await get("/api/telegram");
    expect(state.chats).toEqual([{ id: ME, name: "정" }]);
    expect(state.pairing).toBeNull();

    // 맡길 곳을 고르기 전에는 안내만 한다.
    tg.push(ME, "검색 기능 구현");
    await tg.waitFor(() => lastTo(ME).includes("에이전트를 아직 고르지"));
    await post("/api/telegram/settings", { companyId: "co-1", agentId: "agent-dev" });

    tg.push(ME, "검색 기능 구현\n검색 함수를 추가해 줘");
    await tg.waitFor(() => paperclip.created.length === 1 && lastTo(ME).includes("등록했어요"));
    expect(paperclip.created[0]).toMatchObject({ companyId: "co-1", input: { title: "검색 기능 구현", assigneeAgentId: "agent-dev", status: "todo" } });
    expect(paperclip.created[0]!.input.description).toContain("검색 함수를 추가해 줘");
    expect(lastTo(ME)).toContain("NEX-101");

    // 등록 안내에 답장하면 그 이슈에 댓글로 남기고 다시 연다.
    const ack = [...tg.sent].reverse().find((m) => m.text.includes("등록했어요"))!;
    tg.push(ME, "영어도 지원해 줘", { reply_to_message: { message_id: ack.message_id } });
    await tg.waitFor(() => paperclip.comments.length === 1);
    expect(paperclip.comments[0]).toMatchObject({ issueId: "iss-child-1", reopen: true });
    expect(paperclip.comments[0]!.body).toContain("영어도 지원해 줘");

    tg.push(ME, "/usage");
    await tg.waitFor(() => lastTo(ME).includes("이번 달 사용량"));

    // 다른 사람이 보낸 메시지는 이슈가 되지 않는다.
    tg.push(9999, "몰래 시키는 일");
    await tg.waitFor(() => lastTo(9999).includes("주인만"));
    expect(paperclip.created).toHaveLength(1);

    // 받기를 끄면 등록하지 않는다.
    await post("/api/telegram/settings", { enabled: false });
    tg.push(ME, "또 다른 일");
    await tg.waitFor(() => lastTo(ME).includes("받지 않게"));
    expect(paperclip.created).toHaveLength(1);

    expect((await post("/api/telegram/test", {})).status).toBe(200);
    await post("/api/telegram/unlink", { chatId: ME });
    expect(readTelegramSettings(stateDir).chats).toEqual([]);
  });

  it("틀린 연결 코드를 여러 번 보내면 코드를 없앤다", async () => {
    await post("/api/telegram/token", { token: FAKE_TOKEN });
    const { body: pair } = await post("/api/telegram/pair", {});
    const wrong = pair.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) tg.push(ME, wrong);
    await tg.waitFor(() => lastTo(ME).includes("새 코드를 만들어"));
    tg.push(ME, pair.code);
    await tg.waitFor(() => lastTo(ME).includes("시간이 지났어요"));
    expect(readTelegramSettings(stateDir).chats).toEqual([]);
  });

  it("작업 결과를 연결한 대화방에 짧게 알리고, 답장할 수 있게 메시지와 이슈를 짝지어 둔다", async () => {
    const dir = path.join(tmp, "notify");
    expect(await notifyTelegram(dir, { issueId: "i1", identifier: "NEX-1", text: "x" })).toBe(0);
    writeTelegramSettings(dir, { enabled: true, notifyResults: true, botToken: FAKE_TOKEN, chats: [{ id: ME, name: "정" }] });
    const body = "### Nexus 실행 결과: 완료\n\n- 실행: Claude Code\n\n| 바뀐 파일 | 추가 |\n| --- | --- |\n| a.py | 3 |\n\n#### 확인\n- 테스트: 통과";
    const text = telegramSummary({ id: "i1", identifier: "NEX-1", title: "인사말에 중국어 추가" }, body);
    expect(text.split("\n")[0]).toBe("✅ NEX-1 Nexus 실행 결과: 완료");
    expect(text).toContain("인사말에 중국어 추가");
    expect(text).toContain("■ 확인");
    expect(text).not.toContain("|");
    expect(await notifyTelegram(dir, { issueId: "i1", identifier: "NEX-1", text })).toBe(1);
    expect(lastTo(ME)).toBe(text);
    expect(readMessageLinks(dir)).toEqual([{ chatId: ME, messageId: tg.sent.at(-1)!.message_id, issueId: "i1", identifier: "NEX-1" }]);

    writeTelegramSettings(dir, { ...readTelegramSettings(dir), notifyResults: false });
    expect(await notifyTelegram(dir, { issueId: "i1", text })).toBe(0);
  });
});
