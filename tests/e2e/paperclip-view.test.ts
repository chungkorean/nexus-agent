import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaperclipView, VIEW_SCRIPT_PATH, type PaperclipView } from "../../apps/nexus-server/src/paperclip-view.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../../apps/nexus-server/public/paperclip-ko.js");

let upstream: http.Server;
let target: string;
let view: PaperclipView;
let base: string;
const seen: http.IncomingHttpHeaders[] = [];
const wsSockets = new Set<import("node:stream").Duplex>();

beforeEach(async () => {
  seen.length = 0;
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/old") {
      res.writeHead(302, { location: `${target}/issues/NEX-1` });
      return void res.end();
    }
    if (req.url?.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, path: req.url }));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>Paperclip</title></head><body><aside><a href='/NEX/dashboard'><span>Dashboard</span></a></aside></body></html>");
  });
  // 웹소켓: 연결되면 "hi"를 한 번 보낸다.
  upstream.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    wsSockets.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 2, 0x68, 0x69]));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  view = createPaperclipView({ target, port: 0, scriptFile: SCRIPT });
  base = (await view.listen())!;
});
afterEach(async () => {
  await view.close();
  for (const s of wsSockets) s.destroy();
  wsSockets.clear();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("Paperclip 한국어 보기", () => {
  it("HTML에 한국어 메뉴 스크립트를 넣고, 나머지는 Paperclip에 그대로 넘긴다", async () => {
    const page = await fetch(new URL("/NEX/dashboard", base), { headers: { origin: base.replace(/\/$/, "") } });
    const html = await page.text();
    expect(html).toContain(`<script src="${VIEW_SCRIPT_PATH}" defer></script></head>`);
    expect(Number(page.headers.get("content-length"))).toBe(Buffer.byteLength(html));
    // Paperclip은 자기 주소로 온 요청으로 본다.
    expect(seen[0]!.host).toBe(new URL(target).host);
    expect(seen[0]!.origin).toBe(target);
    expect(seen[0]!["accept-encoding"]).toBe("identity");

    const js = await (await fetch(new URL(VIEW_SCRIPT_PATH, base))).text();
    expect(js).toContain("대시보드");

    const api = await fetch(new URL("/api/companies?x=1", base));
    expect(await api.json()).toEqual({ ok: true, path: "/api/companies?x=1" });

    const moved = await fetch(new URL("/old", base), { redirect: "manual" });
    expect(moved.headers.get("location")).toBe(`${base}issues/NEX-1`);

    // 다른 주소(DNS 리바인딩)로 온 요청은 받지 않는다.
    const port = new URL(base).port;
    const evil = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
    });
    expect(evil).toBe(403);
  });

  it("실시간 갱신용 웹소켓을 잇는다", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "api/live");
    const msg = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("웹소켓 오류"));
    });
    expect(msg).toBe("hi");
    expect(seen.at(-1)!.host).toBe(new URL(target).host);
    ws.close();
  });

  it("Paperclip이 꺼져 있으면 안내 화면을 보여 준다", async () => {
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    const res = await fetch(new URL("/", base));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Paperclip에 연결하지 못했어요");
    upstream = http.createServer();
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  });
});
