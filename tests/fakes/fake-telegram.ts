import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_TOKEN = "123456789:AAHfakeTokenForTestsOnly_abcdefghij";

/** getMe, getUpdates, sendMessage, deleteWebhook만 흉내 내는 가짜 텔레그램 Bot API */
export class FakeTelegram {
  readonly sent: Array<{ chat_id: number; text: string; message_id: number }> = [];
  private updates: Array<{ update_id: number; message: Record<string, unknown> }> = [];
  private nextUpdate = 1;
  private nextMessage = 1000;
  private waiters: Array<() => void> = [];
  private server?: Server;
  url = "";

  /** 사용자가 봇에게 보낸 메시지를 쌓는다. */
  push(chatId: number, text: string, extra: Record<string, unknown> = {}): void {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: { message_id: this.nextMessage++, chat: { id: chatId, type: "private", first_name: "정" }, text, ...extra },
    });
    for (const w of this.waiters.splice(0)) w();
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const m = (req.url ?? "").match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) return send(404, { ok: false, description: "Not Found" });
      if (decodeURIComponent(m[1]!) !== FAKE_TOKEN) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
      switch (m[2]) {
        case "getMe":
          return send(200, { ok: true, result: { id: 1, is_bot: true, first_name: "Nexus", username: "nexus_test_bot" } });
        case "deleteWebhook":
          return send(200, { ok: true, result: true });
        case "sendMessage": {
          const msg = { chat_id: body.chat_id, text: body.text, message_id: this.nextMessage++ };
          this.sent.push(msg);
          return send(200, { ok: true, result: { message_id: msg.message_id, chat: { id: body.chat_id } } });
        }
        case "getUpdates": {
          const offset = Number(body.offset ?? 0);
          const ready = () => this.updates.filter((u) => u.update_id >= offset);
          if (!ready().length) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, Math.min(Number(body.timeout ?? 0), 2) * 1000);
              this.waiters.push(() => {
                clearTimeout(t);
                resolve();
              });
            });
          }
          return send(200, { ok: true, result: ready() });
        }
        default:
          return send(404, { ok: false, description: "Not Found" });
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** 조건이 맞을 때까지 기다린다(최대 5초). */
  async waitFor(check: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("기다리던 일이 일어나지 않았어요");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
