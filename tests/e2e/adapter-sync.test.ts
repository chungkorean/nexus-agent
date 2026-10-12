import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdapterSync } from "../../apps/nexus-server/src/adapter-sync.ts";

let tmp: string;
let adapterDir: string;
let server: http.Server;
let url: string;
let adapters: Array<{ type: string }>;
const calls: Array<{ method: string; url: string; body: any }> = [];

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nexus-sync-"));
  adapterDir = path.join(tmp, "paperclip-adapter");
  mkdirSync(path.join(adapterDir, "dist", "server"), { recursive: true });
  writeFileSync(path.join(adapterDir, "dist", "server", "index.js"), "");
  adapters = [{ type: "claude_local" }];
  calls.length = 0;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/adapters" && req.method === "GET") return void res.end(JSON.stringify(adapters));
      if (req.url === "/api/adapters/install") {
        adapters.push({ type: "nexus_dispatch" });
        return void res.end(JSON.stringify({ type: "nexus_dispatch" }));
      }
      if (req.url === "/api/adapters/nexus_dispatch/reload") return void res.end(JSON.stringify({ reloaded: true }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("Paperclip에 Nexus 어댑터 저절로 설치", () => {
  it("없으면 설치하고, 새 빌드면 다시 불러오고, 그대로면 건드리지 않는다", async () => {
    const opts = { paperclipUrl: url, adapterDir, stateDir: path.join(tmp, "state"), log: () => {} };
    const first = createAdapterSync({ ...opts, build: "aaa" });
    expect(await first.runOnce()).toBe(true);
    expect(first.status().state).toBe("installed");
    expect(calls.find((c) => c.url === "/api/adapters/install")!.body).toEqual({ packageName: adapterDir, isLocalPath: true });

    const same = createAdapterSync({ ...opts, build: "aaa" });
    await same.runOnce();
    expect(same.status().state).toBe("ok");

    const next = createAdapterSync({ ...opts, build: "bbb" });
    await next.runOnce();
    expect(next.status().state).toBe("reloaded");
    expect(calls.filter((c) => c.url.endsWith("/reload")).length).toBe(1);
  });

  it("Paperclip이 꺼져 있으면 기다리고, 로그인을 요구하면 직접 설치하라고 알린다", async () => {
    const off = createAdapterSync({ paperclipUrl: "http://127.0.0.1:1", adapterDir, stateDir: path.join(tmp, "s1"), build: "a", log: () => {} });
    expect(await off.runOnce()).toBe(false);
    expect(off.status().state).toBe("waiting");

    const locked = http.createServer((_req, res) => { res.statusCode = 403; res.end("{}"); });
    await new Promise<void>((r) => locked.listen(0, "127.0.0.1", () => r()));
    const s = createAdapterSync({ paperclipUrl: `http://127.0.0.1:${(locked.address() as AddressInfo).port}`, adapterDir, stateDir: path.join(tmp, "s2"), build: "a", log: () => {} });
    expect(await s.runOnce()).toBe(true);
    expect(s.status()).toMatchObject({ state: "failed", message: expect.stringContaining("직접 설치") });
    await new Promise<void>((r) => locked.close(() => r()));
  });
});
