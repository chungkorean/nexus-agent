/**
 * Paperclip 이슈 API 클라이언트. 어댑터는 Paperclip 서버 안에서 돌기 때문에
 * 실행마다 받는 에이전트 토큰(authToken)과 실행 ID로 호출한다.
 * 참고: https://docs.paperclip.ing/reference/api/issues
 */

export interface PaperclipIssue {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  status?: string;
  companyId?: string;
  projectId?: string | null;
  parentId?: string | null;
  labels?: Array<{ id?: string; name?: string } | string>;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  parentId?: string;
  projectId?: string | null;
  assigneeAgentId?: string;
}

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PaperclipClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly runId: string,
  ) {}

  /** Paperclip이 어댑터 실행 환경에 넣어 주는 API 주소 규칙(buildPaperclipEnv)을 그대로 따른다. */
  static resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.PAPERCLIP_API_URL ?? env.PAPERCLIP_RUNTIME_API_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    let host = (env.PAPERCLIP_LISTEN_HOST ?? env.HOST ?? "localhost").trim();
    if (!host || host === "0.0.0.0" || host === "::") host = "localhost";
    if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
    const port = env.PAPERCLIP_LISTEN_PORT ?? env.PORT ?? "3100";
    return `http://${host}:${port}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.runId) headers["x-paperclip-run-id"] = this.runId;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new PaperclipApiError(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getIssue(issueId: string): Promise<PaperclipIssue> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
  }

  /** reopen: 완료·취소된 이슈를 다시 열어 담당 에이전트를 깨운다 */
  addComment(issueId: string, body: string, opts: { reopen?: boolean } = {}): Promise<unknown> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body, ...(opts.reopen ? { reopen: true } : {}) });
  }

  /** 로컬 모드(local_trusted)에서는 토큰 없이도 회사·에이전트 목록을 읽을 수 있다. */
  listCompanies(): Promise<Array<{ id: string; name?: string; issuePrefix?: string | null }>> {
    return this.request("GET", "/api/companies");
  }

  listAgents(companyId: string): Promise<Array<{ id: string; name?: string; adapterType?: string; status?: string }>> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  }

  /** 최근 댓글부터 limit개 */
  listComments(issueId: string, limit = 30): Promise<PaperclipComment[]> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=desc&limit=${limit}`);
  }

  updateIssue(issueId: string, patch: { status?: string; comment?: string }): Promise<unknown> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }

  createIssue(companyId: string, input: CreateIssueInput): Promise<PaperclipIssue> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, input);
  }
}

export interface PaperclipComment {
  id: string;
  body: string;
  authorType?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: string;
}

export function labelNames(issue: PaperclipIssue): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name ?? ""))
    .filter((n) => n.length > 0);
}
