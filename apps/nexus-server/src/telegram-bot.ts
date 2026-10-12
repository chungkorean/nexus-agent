// 텔레그램 봇: 연결한 대화방에서 보낸 메시지를 Paperclip 이슈로 등록하고, 알림에 답장하면 그 이슈에 댓글로 남긴다.
// 웹훅 대신 getUpdates(긴 폴링)를 써서 공유기 설정이나 공개 주소 없이 집 PC에서 돌아간다.
import { randomInt } from "node:crypto";
import { PaperclipClient } from "@nexus/paperclip-client";
import {
  findMessageLink,
  readTelegramSettings,
  rememberMessageLinks,
  telegramCall,
  TelegramError,
  writeTelegramSettings,
  type TelegramSettings,
} from "@nexus/shared";
import { AssistantError, briefing, createTaskIssue, type AssistantDeps } from "./assistant.ts";
import { VoiceError } from "./voice.ts";

export const PAIRING_MINUTES = 10;
export const PAIRING_MAX_FAILURES = 5;
const POLL_SECONDS = 25;
const IDLE_MS = 3_000;
const ERROR_BACKOFF_MS = [3_000, 10_000, 30_000, 60_000];

interface TgChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number; file_size?: number };
  audio?: { file_id: string; duration?: number; file_size?: number; mime_type?: string; file_name?: string };
  reply_to_message?: { message_id: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramBotOptions {
  stateDir: string;
  paperclipUrl?: string;
  apiBase?: string;
  /** /usage 명령에 보낼 이번 달 사용량 글 */
  usageText?: () => string;
  /** 테스트용: 긴 폴링 시간(초) */
  pollSeconds?: number;
  /** 음성 메시지를 글로 바꾼다. 없으면 음성 메시지를 받지 않는다. */
  transcribe?: (audio: Buffer, ext: string) => Promise<string>;
  /** 오늘 쓴 비용 (/status) */
  todayCost?: () => number;
}

const MAX_VOICE_BYTES = 20 * 1024 * 1024;

export interface TelegramBotStatus {
  running: boolean;
  lastError: string | null;
  lastOkAt: string | null;
}

export function newPairingCode(now = Date.now()): NonNullable<TelegramSettings["pairing"]> {
  return { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: new Date(now + PAIRING_MINUTES * 60_000).toISOString(), failures: 0 };
}

const HELP = [
  "Nexus 봇 사용법",
  "",
  "• 할 일을 그냥 보내면 Paperclip 이슈로 등록해요. 첫 줄은 제목, 둘째 줄부터는 설명이에요.",
  "• 결과 알림에 답장하면 그 이슈에 댓글로 남기고 다시 맡겨요.",
  "• 음성 메시지로 말해도 돼요. PC의 Whisper가 글로 바꿔요.",
  "• /status 진행 상황",
  "• /usage 이번 달 사용량",
  "• /help 이 안내",
].join("\n");

export class TelegramBot {
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private offset = 0;
  private readonly status: TelegramBotStatus = { running: false, lastError: null, lastOkAt: null };

  constructor(private readonly opts: TelegramBotOptions) {}

  getStatus(): TelegramBotStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.status.running = true;
    this.loop = this.run(this.abort.signal).finally(() => {
      this.status.running = false;
      this.loop = null;
    });
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
  }

  private settings(): TelegramSettings {
    return readTelegramSettings(this.opts.stateDir);
  }

  private save(mutate: (s: TelegramSettings) => void): TelegramSettings {
    const s = this.settings();
    mutate(s);
    writeTelegramSettings(this.opts.stateDir, s);
    return s;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let token: string | undefined;
    while (!signal.aborted) {
      const s = this.settings();
      // 토큰이 없으면 쉬었다가 다시 본다. 토큰을 바꾸면 처음부터 받는다.
      if (!s.botToken) {
        token = undefined;
        await sleep(IDLE_MS, signal);
        continue;
      }
      if (s.botToken !== token) {
        token = s.botToken;
        this.offset = 0;
      }
      try {
        const updates = await telegramCall<TgUpdate[]>(
          token,
          "getUpdates",
          { offset: this.offset, timeout: this.opts.pollSeconds ?? POLL_SECONDS, allowed_updates: ["message"] },
          { signal, timeoutMs: ((this.opts.pollSeconds ?? POLL_SECONDS) + 10) * 1000, apiBase: this.opts.apiBase },
        );
        failures = 0;
        this.status.lastError = null;
        this.status.lastOkAt = new Date().toISOString();
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) await this.handle(token, u.message).catch((err) => this.reply(token!, u.message!.chat.id, `처리하지 못했어요: ${(err as Error).message}`).catch(() => undefined));
        }
      } catch (err) {
        if (signal.aborted) break;
        this.status.lastError = err instanceof TelegramError && err.code === 401 ? "봇 토큰이 맞지 않아요. 설정 화면에서 다시 넣어 주세요." : (err as Error).message;
        // 다른 곳에서 같은 봇으로 받고 있으면(409) 잠시 뒤 다시 시도한다.
        await sleep(ERROR_BACKOFF_MS[Math.min(failures, ERROR_BACKOFF_MS.length - 1)]!, signal);
        failures++;
      }
    }
  }

  /** 메시지 하나 처리. 테스트에서 바로 부를 수 있게 열어 둔다. */
  async handle(token: string, msg: TgMessage): Promise<void> {
    const s = this.settings();
    const chatId = msg.chat.id;
    let text = (msg.text ?? msg.caption ?? "").trim();
    const linked = s.chats.some((c) => c.id === chatId);

    if (!linked) {
      if (msg.chat.type !== "private") return;
      const code = text.replace(/^\/start\s*/i, "").trim();
      if (!/^\d{6}$/.test(code)) {
        await this.reply(token, chatId, "이 봇은 Nexus 주인만 쓸 수 있어요. Nexus 설정 화면의 '텔레그램' 칸에서 연결 코드를 만들어 6자리 숫자를 보내 주세요.");
        return;
      }
      const p = s.pairing;
      if (!p || Date.parse(p.expiresAt) < Date.now()) {
        await this.reply(token, chatId, "연결 코드가 없거나 시간이 지났어요. 설정 화면에서 새 코드를 만들어 주세요.");
        return;
      }
      if (p.code !== code) {
        const next = this.save((x) => {
          if (!x.pairing) return;
          x.pairing.failures += 1;
          if (x.pairing.failures >= PAIRING_MAX_FAILURES) delete x.pairing;
        });
        await this.reply(token, chatId, next.pairing ? "연결 코드가 맞지 않아요. 다시 확인해 주세요." : "틀린 코드를 여러 번 보내 연결 코드를 없앴어요. 설정 화면에서 새 코드를 만들어 주세요.");
        return;
      }
      const name = chatName(msg.chat);
      this.save((x) => {
        delete x.pairing;
        if (!x.chats.some((c) => c.id === chatId)) x.chats.push({ id: chatId, name });
      });
      await this.reply(token, chatId, `연결했어요, ${name}님. 이제 할 일을 보내면 Paperclip에 등록하고, 끝나면 결과를 알려 드릴게요.\n\n${HELP}`);
      return;
    }

    const voice = msg.voice ?? msg.audio;
    if (!text && voice) {
      if (!this.opts.transcribe) {
        await this.reply(token, chatId, "음성 메시지는 아직 받지 못해요. 글로 보내 주세요.");
        return;
      }
      try {
        text = await this.hear(token, voice.file_id, voice.file_size, msg.voice ? ".oga" : extOf(msg.audio?.file_name, msg.audio?.mime_type));
      } catch (err) {
        await this.reply(token, chatId, err instanceof VoiceError ? err.message : `음성 메시지를 글로 바꾸지 못했어요: ${(err as Error).message}`);
        return;
      }
      if (!text) {
        await this.reply(token, chatId, "음성 메시지에서 말을 알아듣지 못했어요. 다시 보내 주세요.");
        return;
      }
      await this.reply(token, chatId, `🎤 들은 말: ${text}`);
    }
    if (!text) {
      await this.reply(token, chatId, "글이나 음성으로 보내 주세요. 사진이나 파일은 아직 받지 못해요.");
      return;
    }
    if (/^\/(start|help)\b/i.test(text)) {
      await this.reply(token, chatId, HELP);
      return;
    }
    if (/^\/status\b/i.test(text)) {
      const b = await briefing(this.deps());
      await this.reply(token, chatId, b.text);
      return;
    }
    if (/^\/usage\b/i.test(text)) {
      await this.reply(token, chatId, this.opts.usageText?.() ?? "사용량을 읽지 못했어요.");
      return;
    }
    if (text.startsWith("/")) {
      await this.reply(token, chatId, `모르는 명령이에요.\n\n${HELP}`);
      return;
    }

    const client = new PaperclipClient(this.opts.paperclipUrl ?? PaperclipClient.resolveBaseUrl(), undefined, "");

    // 알림에 답장: 그 이슈에 댓글로 남기고 다시 연다.
    if (msg.reply_to_message) {
      const link = findMessageLink(this.opts.stateDir, chatId, msg.reply_to_message.message_id);
      if (link) {
        await client.addComment(link.issueId, `${text}\n\n_(텔레그램에서 보냄)_`, { reopen: true });
        await this.reply(token, chatId, `${link.identifier ?? "이슈"}에 댓글로 남기고 다시 맡겼어요.`);
        return;
      }
    }

    if (!s.enabled) {
      await this.reply(token, chatId, "지금은 텔레그램으로 일을 받지 않게 설정돼 있어요. 설정 화면의 '텔레그램' 칸에서 켤 수 있어요.");
      return;
    }
    if (!s.companyId || !s.agentId) {
      await this.reply(token, chatId, "일을 맡길 Paperclip 회사와 에이전트를 아직 고르지 않았어요. 설정 화면의 '텔레그램' 칸에서 골라 주세요.");
      return;
    }
    let issue;
    try {
      issue = await createTaskIssue(this.deps(), text, "telegram", { companyId: s.companyId, agentId: s.agentId });
    } catch (err) {
      await this.reply(token, chatId, err instanceof AssistantError ? err.message : `이슈를 만들지 못했어요: ${(err as Error).message}`);
      return;
    }
    const title = issue.title;
    const sent = await this.reply(token, chatId, `${issue.identifier ?? "새 이슈"}로 등록했어요: ${title}\n끝나면 결과를 알려 드릴게요. 이 메시지에 답장하면 이슈에 덧붙여요.`);
    if (sent) rememberMessageLinks(this.opts.stateDir, [{ chatId, messageId: sent, issueId: issue.id, ...(issue.identifier ? { identifier: issue.identifier } : {}) }]);
  }

  private deps(): AssistantDeps {
    return {
      stateDir: this.opts.stateDir,
      paperclipUrl: this.opts.paperclipUrl ?? PaperclipClient.resolveBaseUrl(),
      usageText: this.opts.usageText ?? (() => "사용량을 읽지 못했어요."),
      todayCost: this.opts.todayCost,
    };
  }

  /** 음성 메시지를 받아 글로 바꾼다. */
  private async hear(token: string, fileId: string, size: number | undefined, ext: string): Promise<string> {
    if (size && size > MAX_VOICE_BYTES) throw new VoiceError("음성 메시지가 너무 길어요. 짧게 나눠 보내 주세요.");
    const file = await telegramCall<{ file_path?: string }>(token, "getFile", { file_id: fileId }, { apiBase: this.opts.apiBase });
    if (!file.file_path) throw new Error("파일 주소를 받지 못했어요");
    const res = await fetch(`${apiRoot(this.opts.apiBase)}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`파일을 받지 못했어요 (${res.status})`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length > MAX_VOICE_BYTES) throw new VoiceError("음성 메시지가 너무 길어요. 짧게 나눠 보내 주세요.");
    return this.opts.transcribe!(audio, ext);
  }

  private async reply(token: string, chatId: number, text: string): Promise<number | null> {
    try {
      const msg = await telegramCall<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }, { apiBase: this.opts.apiBase });
      return msg.message_id;
    } catch {
      return null;
    }
  }
}

function extOf(name: string | undefined, mime: string | undefined): string {
  const fromName = name?.match(/\.[A-Za-z0-9]{2,5}$/)?.[0]?.toLowerCase();
  if (fromName) return fromName;
  if (mime?.includes("mpeg")) return ".mp3";
  if (mime?.includes("wav")) return ".wav";
  if (mime?.includes("mp4") || mime?.includes("m4a")) return ".m4a";
  return ".ogg";
}

function apiRoot(apiBase: string | undefined): string {
  return (apiBase ?? process.env.NEXUS_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
}

function chatName(chat: TgChat): string {
  return [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || chat.title || String(chat.id);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
