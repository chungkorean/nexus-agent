import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaperclipIssue } from "@nexus/paperclip-client";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** 이슈 조회, 댓글, 상태 변경, 하위 이슈 생성만 흉내 내는 가짜 Paperclip API */
export class FakePaperclip {
  readonly issues = new Map<string, PaperclipIssue>();
  readonly comments: Array<{ issueId: string; body: string }> = [];
  readonly created: Array<{ companyId: string; input: Record<string, unknown> }> = [];
  readonly requests: RecordedRequest[] = [];
  private server?: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? "/";
      this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };

      let m = path.match(/^\/api\/issues\/([^/]+)$/);
      if (m && req.method === "GET") {
        const issue = this.issues.get(decodeURIComponent(m[1]!));
        return issue ? send(200, issue) : send(404, { error: "not found" });
      }
      if (m && req.method === "PATCH") {
        const issue = this.issues.get(decodeURIComponent(m[1]!));
        if (!issue) return send(404);
        Object.assign(issue, { status: (body as { status?: string }).status ?? issue.status });
        return send(200, issue);
      }
      m = path.match(/^\/api\/issues\/([^/]+)\/comments$/);
      if (m && req.method === "POST") {
        this.comments.push({ issueId: decodeURIComponent(m[1]!), body: (body as { body: string }).body });
        return send(201, { id: `c${this.comments.length}` });
      }
      m = path.match(/^\/api\/companies\/([^/]+)\/issues$/);
      if (m && req.method === "POST") {
        const id = `iss-child-${this.created.length + 1}`;
        this.created.push({ companyId: decodeURIComponent(m[1]!), input: body as Record<string, unknown> });
        const issue = { id, identifier: `NEX-${100 + this.created.length}`, ...(body as object) } as PaperclipIssue;
        this.issues.set(id, issue);
        return send(201, issue);
      }
      send(404, { error: "not found" });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
