// Paperclip 화면을 Nexus 창에서 보여 주는 작은 중계 서버.
// Paperclip이 보낸 HTML에 한국어 메뉴 이름과 설명(?)을 붙이는 스크립트 한 줄을 넣고,
// 나머지 요청과 웹소켓은 그대로 Paperclip에 넘긴다. Paperclip 자체는 건드리지 않는다.
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";

export const VIEW_SCRIPT_PATH = "/__nexus/paperclip-ko.js";

export interface PaperclipViewOptions {
  /** Paperclip 주소, 예: http://localhost:3100 */
  target: string;
  /** 0이면 아무 번호 */
  port: number;
  /** 넣을 스크립트 파일 */
  scriptFile: string;
}

export interface PaperclipView {
  /** 연 주소. 번호를 못 쓰면 null(그때는 Paperclip을 그대로 띄운다). */
  listen(): Promise<string | null>;
  close(): Promise<void>;
  readonly port: number | null;
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

export function createPaperclipView(o: PaperclipViewOptions): PaperclipView {
  const target = new URL(o.target);
  const targetHost = target.host;
  const targetPort = Number(target.port) || 80;
  let allowed = new Set<string>();
  let self = "";
  let boundPort: number | null = null;
  const tunnels = new Set<net.Socket>();

  /** 브라우저가 보낸 머리글을 Paperclip이 자기에게 온 요청으로 보게 고친다. */
  function forwardHeaders(h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = v;
    out.host = targetHost;
    if (out.origin) out.origin = target.origin;
    if (typeof out.referer === "string") out.referer = out.referer.replace(self, target.origin);
    return out;
  }

  function fromTarget(v: string): string {
    return v.startsWith(target.origin) ? self + v.slice(target.origin.length) : v;
  }

  const server = http.createServer((req, res) => {
    if (!allowed.has((req.headers.host ?? "").toLowerCase())) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("127.0.0.1 주소로 열어 주세요.");
    }
    if (req.url === VIEW_SCRIPT_PATH) {
      let body = "";
      try {
        body = readFileSync(o.scriptFile, "utf8");
      } catch {}
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return void res.end(body);
    }
    const headers = forwardHeaders(req.headers);
    // HTML에 스크립트를 넣어야 하므로 압축하지 않은 응답을 받는다. 같은 PC 안이라 느려지지 않는다.
    headers["accept-encoding"] = "identity";
    const up = http.request({ host: target.hostname, port: targetPort, method: req.method, path: req.url, headers }, (pr) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(pr.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
      if (typeof out.location === "string") out.location = fromTarget(out.location);
      const html = String(pr.headers["content-type"] ?? "").includes("text/html");
      if (!html) {
        res.writeHead(pr.statusCode ?? 502, out);
        return void pr.pipe(res);
      }
      const chunks: Buffer[] = [];
      pr.on("data", (c: Buffer) => chunks.push(c));
      pr.on("end", () => {
        let text = Buffer.concat(chunks).toString("utf8");
        const tag = `<script src="${VIEW_SCRIPT_PATH}" defer></script>`;
        text = text.includes("</head>") ? text.replace("</head>", `${tag}</head>`) : tag + text;
        const body = Buffer.from(text, "utf8");
        delete out["content-encoding"];
        out["content-length"] = body.length;
        res.writeHead(pr.statusCode ?? 200, out);
        res.end(body);
      });
      pr.on("error", () => res.destroy());
    });
    up.on("error", () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end('<p style="font-family:sans-serif;padding:24px">Paperclip에 연결하지 못했어요. Paperclip이 켜져 있는지 확인해 주세요.</p>');
    });
    req.pipe(up);
  });

  // 실시간 갱신용 웹소켓은 머리글만 고쳐 그대로 잇는다.
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!allowed.has((req.headers.host ?? "").toLowerCase())) return void socket.destroy();
    const upstream = net.connect(targetPort, target.hostname, () => {
      const headers = forwardHeaders(req.headers);
      headers.connection = "Upgrade";
      headers.upgrade = req.headers.upgrade;
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
    upstream.on("close", end);
    socket.on("close", end);
  });

  return {
    get port() {
      return boundPort;
    },
    listen() {
      return new Promise((resolve) => {
        server.once("error", (err) => {
          console.error(`  Paperclip 한국어 보기를 열지 못했어요(${(err as Error).message}). Paperclip을 그대로 보여 줄게요.`);
          resolve(null);
        });
        server.listen(o.port, "127.0.0.1", () => {
          boundPort = (server.address() as AddressInfo).port;
          allowed = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
          self = `http://127.0.0.1:${boundPort}`;
          resolve(`${self}/`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        for (const s of tunnels) s.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
