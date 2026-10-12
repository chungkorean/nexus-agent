import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 텔레그램 연결 설정. 봇 토큰이 들어 있어 설정 YAML(백업·되돌리기 대상)이 아니라
 * state 폴더의 telegram.json에 둔다.
 */
export interface TelegramSettings {
  /** 텔레그램으로 보낸 메시지를 Paperclip 이슈로 등록할지 */
  enabled: boolean;
  /** 작업이 끝나면 연결한 대화방에 결과를 알릴지 */
  notifyResults: boolean;
  botToken?: string;
  botName?: string;
  /** 연결 코드로 짝지은 대화방. 이 대화방의 메시지만 받는다. */
  chats: Array<{ id: number; name: string }>;
  /** 새 이슈를 만들 Paperclip 회사와 맡길 에이전트 */
  companyId?: string;
  agentId?: string;
  /** 설정 화면에서 만든 일회용 연결 코드 */
  pairing?: { code: string; expiresAt: string; failures: number };
}

/** 알림 메시지에 답장하면 그 이슈에 댓글로 남기려고, 보낸 메시지와 이슈를 짝지어 둔다. */
export interface TelegramMessageLink {
  chatId: number;
  messageId: number;
  issueId: string;
  identifier?: string;
}

const MAX_LINKS = 500;
const SEND_TIMEOUT_MS = 10_000;

export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NEXUS_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
}

export function readTelegramSettings(stateDir: string): TelegramSettings {
  const fallback: TelegramSettings = { enabled: true, notifyResults: true, chats: [] };
  try {
    const raw = JSON.parse(readFileSync(path.join(stateDir, "telegram.json"), "utf8")) as Partial<TelegramSettings>;
    return {
      ...fallback,
      ...raw,
      enabled: raw.enabled !== false,
      notifyResults: raw.notifyResults !== false,
      chats: Array.isArray(raw.chats) ? raw.chats.filter((c) => typeof c?.id === "number") : [],
    };
  } catch {
    return fallback;
  }
}

export function writeTelegramSettings(stateDir: string, s: TelegramSettings): void {
  writeJson(path.join(stateDir, "telegram.json"), s);
}

export function readMessageLinks(stateDir: string): TelegramMessageLink[] {
  try {
    const list = JSON.parse(readFileSync(path.join(stateDir, "telegram-messages.json"), "utf8")) as TelegramMessageLink[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function rememberMessageLinks(stateDir: string, links: TelegramMessageLink[]): void {
  if (!links.length) return;
  try {
    writeJson(path.join(stateDir, "telegram-messages.json"), [...readMessageLinks(stateDir), ...links].slice(-MAX_LINKS));
  } catch {
    /* 못 남겨도 알림은 이미 갔다 */
  }
}

export function findMessageLink(stateDir: string, chatId: number, messageId: number): TelegramMessageLink | undefined {
  return readMessageLinks(stateDir).find((l) => l.chatId === chatId && l.messageId === messageId);
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** 텔레그램 Bot API 호출. 실패하면 TelegramError (토큰은 메시지에 넣지 않는다) */
export async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; timeoutMs?: number; apiBase?: string } = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])];
  let res: Response;
  try {
    res = await fetch(`${opts.apiBase ?? telegramApiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    throw new TelegramError(`텔레그램에 연결하지 못했어요 (${(err as Error).name === "TimeoutError" ? "시간 초과" : (err as Error).message})`);
  }
  let data: { ok?: boolean; result?: T; description?: string; error_code?: number };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new TelegramError(`텔레그램 응답을 읽지 못했어요 (${res.status})`, res.status);
  }
  if (!res.ok || !data.ok) throw new TelegramError(data.description ?? `텔레그램 오류 ${res.status}`, data.error_code ?? res.status);
  return data.result as T;
}

/** 텔레그램 메시지는 4096자까지. 넘으면 자른다. */
export function clipTelegram(text: string, max = 3900): string {
  return text.length > max ? `${text.slice(0, max)}\n…(생략)` : text;
}

/**
 * 작업 결과를 연결한 대화방에 알린다. 설정이 없거나 꺼져 있으면 아무것도 하지 않고,
 * 실패해도 예외를 던지지 않는다(실행 결과에 영향을 주지 않는다).
 */
export async function notifyTelegram(
  stateDir: string,
  input: { issueId: string; identifier?: string | null; text: string },
  log?: (line: string) => unknown,
): Promise<number> {
  const s = readTelegramSettings(stateDir);
  if (!s.notifyResults || !s.botToken || !s.chats.length) return 0;
  const links: TelegramMessageLink[] = [];
  for (const chat of s.chats) {
    try {
      const msg = await telegramCall<{ message_id: number }>(s.botToken, "sendMessage", {
        chat_id: chat.id,
        text: clipTelegram(input.text),
        disable_web_page_preview: true,
      });
      links.push({ chatId: chat.id, messageId: msg.message_id, issueId: input.issueId, ...(input.identifier ? { identifier: input.identifier } : {}) });
    } catch (err) {
      await log?.(`텔레그램 알림 실패 (${chat.name}): ${(err as Error).message}`);
    }
  }
  rememberMessageLinks(stateDir, links);
  return links.length;
}
