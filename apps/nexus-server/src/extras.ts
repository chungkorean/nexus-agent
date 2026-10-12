// 스튜디오(작업 기록·미디어)와 음성 비서 화면이 쓰는 API.
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { PaperclipClient } from "@nexus/paperclip-client";
import { archiveDir, archiveMediaPath, isArchiveId, listArchive, mediaInfo, readArchive, removeArchive, type CommandSpec } from "@nexus/shared";
import { respond, type AssistantDeps } from "./assistant.ts";
import { HttpError } from "./errors.ts";
import { engineReady, findWhisper, senseVoiceDir, VOICE_ENGINES, type TranscribeCommands, type VoiceEngine, LANGUAGES, readVoiceSettings, transcribe, voiceDir, WHISPER_MODELS, writeVoiceSettings, DEFAULT_WHISPER_MODEL, type ToolInstaller, type VoiceSettings } from "./voice.ts";

export interface ExtrasOptions {
  stateDir: string;
  paperclipUrl: string;
  assistant: () => AssistantDeps;
  commands?: TranscribeCommands;
  installer: ToolInstaller;
  build?: string | null;
  version?: string | null;
  /** 이 서버를 띄운 저장소 폴더(어느 폴더의 Nexus가 떠 있는지 보여 주려고) */
  root?: string;
  /** 저장소의 지금 커밋 */
  head?: () => string | null;
  /** Paperclip 한국어 보기 주소. 못 열었으면 null */
  viewUrl?: () => string | null;
  /** Paperclip에 Nexus 어댑터를 저절로 설치한 결과 */
  adapterStatus?: () => unknown;
  targets: (companyId: string | null | undefined) => Promise<{ companies: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string; adapterType: string }>; paperclipError: string | null }>;
}

type Body = Record<string, unknown>;
const ID_LIKE = /^[A-Za-z0-9_-]{1,80}$/;

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.trim().slice(0, max) : undefined;
}

function archiveId(v: unknown): string {
  const id = typeof v === "string" ? v : "";
  if (!isArchiveId(id)) throw new HttpError(400, "작업 기록을 다시 골라 주세요.");
  return id;
}

export function createExtras(o: ExtrasOptions) {
  const client = () => new PaperclipClient(o.paperclipUrl, undefined, "");
  /** 빌드한 뒤 git pull로 새 코드를 받았는데 아직 다시 켜지 않았으면 true */
  const isStale = () => {
    const head = o.head?.();
    return Boolean(o.build && head && head !== o.build);
  };

  function voiceState() {
    const s = readVoiceSettings(o.stateDir);
    const setup = findWhisper(s);
    return {
      settings: s,
      setup: {
        ready: engineReady(s.engine, setup, o.commands),
        engines: { whisper: engineReady("whisper", setup, o.commands), sensevoice: engineReady("sensevoice", setup, o.commands) },
        sensevoice: setup.sensevoice,
        whisper: setup.whisper,
        model: setup.model,
        models: setup.models.map((p) => ({ path: p, name: path.basename(p) })),
        ffmpeg: setup.ffmpeg,
        dir: setup.dir,
      },
      install: o.installer.state,
      whisperModels: WHISPER_MODELS,
      defaultModel: DEFAULT_WHISPER_MODEL,
      languages: LANGUAGES,
      platform: process.platform,
    };
  }

  const get: Record<string, (url: URL) => Promise<object> | object> = {
    "/api/info": () => ({ paperclipUrl: o.paperclipUrl, platform: process.platform, build: o.build ?? null, version: o.version ?? null, stale: isStale(), root: o.root ?? null }),

    "/api/archive": (url) => ({
      items: listArchive(o.stateDir, {
        q: url.searchParams.get("q")?.slice(0, 100) ?? undefined,
        mediaOnly: url.searchParams.get("media") === "1",
        limit: Math.min(500, Number(url.searchParams.get("limit")) || 200),
      }),
      dir: archiveDir(o.stateDir),
    }),

    "/api/archive/item": (url) => {
      const found = readArchive(o.stateDir, archiveId(url.searchParams.get("id")));
      if (!found) throw new HttpError(404, "그 작업 기록이 없어요. 지워졌을 수 있어요.");
      return found;
    },

    // 스튜디오 채팅의 "맡길 곳". 음성 비서와 같은 설정을 쓴다.
    "/api/intake": async (url) => {
      const s = readVoiceSettings(o.stateDir);
      const q = url.searchParams.get("companyId");
      const targets = await o.targets(q && ID_LIKE.test(q) ? q : s.companyId);
      return { companyId: s.companyId ?? null, agentId: s.agentId ?? null, ...targets };
    },

    "/api/paperclip": async () => {
      let up = false;
      try {
        const res = await fetch(o.paperclipUrl, { signal: AbortSignal.timeout(2500) });
        up = res.status < 500;
      } catch {}
      return { url: o.paperclipUrl, view: o.viewUrl?.() ?? null, up, adapter: o.adapterStatus?.() ?? null };
    },

    "/api/voice": async (url) => {
      const s = readVoiceSettings(o.stateDir);
      const q = url.searchParams.get("companyId");
      const targets = await o.targets(q && ID_LIKE.test(q) ? q : s.companyId);
      return { ...voiceState(), ...targets };
    },
  };

  const post: Record<string, (body: Body) => Promise<unknown> | unknown> = {
    "/api/archive/continue": async (body) => {
      const id = archiveId(body.id);
      const found = readArchive(o.stateDir, id);
      if (!found) throw new HttpError(404, "그 작업 기록이 없어요.");
      const text = str(body.text, 4000);
      if (!text) throw new HttpError(400, "이어서 맡길 내용을 적어 주세요.");
      try {
        await client().addComment(found.record.issueId, `${text}\n\n_(Nexus 스튜디오에서 이어서 맡김)_`, { reopen: true });
      } catch (err) {
        const offline = !/→ \d{3}/.test((err as Error).message);
        throw new HttpError(502, offline ? "Paperclip에 연결하지 못했어요. Paperclip이 켜져 있는지 확인해 주세요." : `이어서 맡기지 못했어요: ${(err as Error).message}`);
      }
      return { ok: true, message: `${found.record.identifier ?? "이슈"}에 댓글로 남기고 다시 맡겼어요. Paperclip이 이전 대화를 이어서 작업해요.` };
    },

    "/api/archive/remove": (body) => {
      const id = archiveId(body.id);
      if (!removeArchive(o.stateDir, id)) throw new HttpError(404, "그 작업 기록이 없어요.");
      return { ok: true, message: "작업 기록을 지웠어요. Paperclip의 이슈는 그대로 있어요." };
    },

    "/api/archive/open": (body) => {
      const id = archiveId(body.id);
      const dir = path.join(archiveDir(o.stateDir), id);
      if (!readArchive(o.stateDir, id)) throw new HttpError(404, "그 작업 기록이 없어요.");
      if (process.platform !== "win32") return { ok: true, message: `폴더: ${dir}` };
      spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      return { ok: true, message: "탐색기로 폴더를 열었어요." };
    },

    "/api/voice/settings": (body) => {
      const s = readVoiceSettings(o.stateDir);
      const next: VoiceSettings = { ...s };
      if (body.language !== undefined) {
        if (!LANGUAGES.includes(String(body.language))) throw new HttpError(400, "언어를 다시 골라 주세요.");
        next.language = String(body.language);
      }
      if (body.wakeWord !== undefined) {
        const w = str(body.wakeWord, 20);
        if (!w || w.length < 2) throw new HttpError(400, "호출어는 두 글자 이상이에요.");
        next.wakeWord = w;
      }
      if (typeof body.speak === "boolean") next.speak = body.speak;
      if (body.engine !== undefined) {
        if (!VOICE_ENGINES.includes(body.engine as VoiceEngine)) throw new HttpError(400, "엔진을 다시 골라 주세요.");
        next.engine = body.engine as VoiceEngine;
      }
      for (const key of ["whisperPath", "modelPath", "ffmpegPath"] as const) {
        if (body[key] === undefined) continue;
        const v = str(body[key], 400);
        if (v) next[key] = v.replace(/^"|"$/g, "");
        else delete next[key];
      }
      if (body.companyId !== undefined) {
        const v = str(body.companyId, 80);
        if (v && !ID_LIKE.test(v)) throw new HttpError(400, "회사를 다시 골라 주세요.");
        if (v !== s.companyId) delete next.agentId;
        if (v) next.companyId = v;
        else delete next.companyId;
      }
      if (body.agentId !== undefined) {
        const v = str(body.agentId, 80);
        if (v && !ID_LIKE.test(v)) throw new HttpError(400, "에이전트를 다시 골라 주세요.");
        if (v) next.agentId = v;
        else delete next.agentId;
      }
      writeVoiceSettings(o.stateDir, next);
      return { ok: true, message: "음성 설정을 저장했어요.", ...voiceState() };
    },

    "/api/voice/install": (body) => {
      o.installer.startWhisper(String(body.model ?? DEFAULT_WHISPER_MODEL), voiceDir());
      return { ok: true, message: "Whisper를 받기 시작했어요. 모델 크기에 따라 몇 분 걸려요.", install: o.installer.state };
    },

    "/api/voice/install-sensevoice": () => {
      o.installer.startSenseVoice(senseVoiceDir());
      return { ok: true, message: "SenseVoice를 받기 시작했어요. 몇 분 걸려요.", install: o.installer.state };
    },

    "/api/voice/install-ffmpeg": () => {
      o.installer.startFfmpeg(voiceDir());
      return { ok: true, message: "ffmpeg를 받기 시작했어요. 1~2분 걸려요.", install: o.installer.state };
    },

    "/api/chat": async (body) => {
      const text = str(body.text, 8000);
      if (!text) throw new HttpError(400, "보낼 내용을 적어 주세요.");
      return { ok: true, reply: await respond(o.assistant(), text, "studio") };
    },

    "/api/voice/command": async (body) => {
      const text = str(body.text, 2000);
      if (!text) throw new HttpError(400, "명령이 비어 있어요.");
      return { ok: true, reply: await respond(o.assistant(), text, "voice") };
    },

    "/api/voice/cancel": async (body) => {
      const issueId = str(body.issueId, 80);
      if (!issueId || !ID_LIKE.test(issueId)) throw new HttpError(400, "취소할 이슈를 다시 골라 주세요.");
      try {
        await client().updateIssue(issueId, { status: "cancelled" });
      } catch (err) {
        throw new HttpError(502, `취소하지 못했어요: ${(err as Error).message}`);
      }
      return { ok: true, message: "방금 등록한 일을 취소했어요." };
    },
  };

  /** 보관함 미디어 파일. 오디오·비디오 탐색을 위해 Range를 지원한다. */
  function media(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = archiveId(url.searchParams.get("id"));
    const name = url.searchParams.get("name") ?? "";
    const file = archiveMediaPath(o.stateDir, id, name);
    const info = file ? mediaInfo(file) : null;
    if (!file || !info) throw new HttpError(404, "그 파일이 없어요.");
    const size = statSync(file).size;
    const headers: Record<string, string | number> = {
      "content-type": info.mime,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // AI가 만든 SVG를 새 탭에서 열어도 스크립트가 돌지 않게 한다.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return void res.end();
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return void res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  async function transcribeUpload(audio: Buffer, contentType: string): Promise<{ text: string }> {
    if (audio.length < 1000) throw new HttpError(400, "소리가 너무 짧아요.");
    const ext = contentType.includes("wav") ? ".wav" : contentType.includes("webm") ? ".webm" : contentType.includes("ogg") ? ".ogg" : contentType.includes("mpeg") ? ".mp3" : ".wav";
    const s = readVoiceSettings(o.stateDir);
    const text = await transcribe(audio, ext, s, findWhisper(s), { commands: o.commands, tmpDir: path.join(o.stateDir, "tmp") });
    return { text };
  }

  return { get, post, media, transcribe: transcribeUpload };
}
