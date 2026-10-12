// 음성 비서: 내 컴퓨터의 Whisper(whisper.cpp)로 말을 글로 바꾼다. 소리는 밖으로 보내지 않는다.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nexusHome, runProcess, startProcess, type CommandSpec } from "@nexus/shared";

export interface VoiceSettings {
  /** Whisper에 알려 줄 언어. auto면 알아서 */
  language: string;
  /** 이 말로 시작하면 명령으로 듣는다 */
  wakeWord: string;
  /** 답을 소리로 읽어 줄지 */
  speak: boolean;
  /** 직접 고른 Whisper 실행 파일·모델·ffmpeg. 비우면 Nexus 폴더에서 찾는다 */
  whisperPath?: string;
  modelPath?: string;
  ffmpegPath?: string;
  /** 음성으로 만든 일을 맡길 곳. 비우면 텔레그램 설정을 따른다 */
  companyId?: string;
  agentId?: string;
}

export const DEFAULT_VOICE: VoiceSettings = { language: "ko", wakeWord: "넥서스", speak: true };

export const WHISPER_MODELS = [
  { id: "base", label: "빠름", size: "142MB", note: "빠르지만 한국어를 자주 틀려요" },
  { id: "small", label: "보통", size: "466MB", note: "추천. 대부분의 PC에서 1~3초" },
  { id: "large-v3-turbo-q5_0", label: "정확", size: "547MB", note: "가장 정확하지만 느린 PC에서는 오래 걸려요" },
] as const;

export const LANGUAGES = ["ko", "en", "ja", "zh", "auto"];

export function voiceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(nexusHome(env), "whisper");
}

export function readVoiceSettings(stateDir: string): VoiceSettings {
  try {
    const raw = JSON.parse(readFileSync(path.join(stateDir, "voice.json"), "utf8")) as Partial<VoiceSettings>;
    return {
      ...DEFAULT_VOICE,
      ...raw,
      language: LANGUAGES.includes(String(raw.language)) ? String(raw.language) : DEFAULT_VOICE.language,
      wakeWord: typeof raw.wakeWord === "string" && raw.wakeWord.trim() ? raw.wakeWord.trim().slice(0, 20) : DEFAULT_VOICE.wakeWord,
      speak: raw.speak !== false,
    };
  } catch {
    return { ...DEFAULT_VOICE };
  }
}

export function writeVoiceSettings(stateDir: string, s: VoiceSettings): void {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "voice.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

export interface WhisperSetup {
  /** 찾은 Whisper 실행 파일 (없으면 null) */
  whisper: string | null;
  /** 쓸 모델 파일 */
  model: string | null;
  /** 설치된 모델 파일 전체 */
  models: string[];
  /** 텔레그램 음성 메시지(OGG)를 바꿀 ffmpeg */
  ffmpeg: string | null;
  /** Nexus가 Whisper를 설치하는 폴더 */
  dir: string;
}

const EXE = process.platform === "win32" ? ".exe" : "";
const MODEL_ORDER = ["large-v3-turbo-q5_0", "small", "base"];

function isFile(p: string | undefined): p is string {
  try {
    return Boolean(p) && statSync(p!).isFile();
  } catch {
    return false;
  }
}

/** PATH에서 실행 파일 찾기 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** Whisper 실행 파일, 모델, ffmpeg를 찾는다. */
export function findWhisper(s: VoiceSettings, env: NodeJS.ProcessEnv = process.env): WhisperSetup {
  const dir = voiceDir(env);
  const whisper =
    [s.whisperPath, path.join(dir, `whisper-cli${EXE}`), path.join(dir, "Release", `whisper-cli${EXE}`), path.join(dir, `main${EXE}`)].find(isFile) ??
    onPath("whisper-cli", env) ??
    null;
  let models: string[] = [];
  try {
    models = readdirSync(path.join(dir, "models"))
      .filter((f) => /^ggml-.+\.bin$/.test(f))
      .map((f) => path.join(dir, "models", f));
  } catch {
    /* 아직 설치하지 않았다 */
  }
  if (isFile(s.modelPath) && !models.includes(s.modelPath)) models.unshift(s.modelPath);
  const rank = (f: string) => {
    const i = MODEL_ORDER.findIndex((m) => path.basename(f) === `ggml-${m}.bin`);
    return i < 0 ? MODEL_ORDER.length : i;
  };
  const model = isFile(s.modelPath) ? s.modelPath : ([...models].sort((a, b) => rank(a) - rank(b))[0] ?? null);
  const ffmpeg = [s.ffmpegPath, path.join(dir, `ffmpeg${EXE}`)].find(isFile) ?? onPath("ffmpeg", env) ?? null;
  return { whisper, model, models, ffmpeg, dir };
}

/** Whisper가 조용한 소리에서 지어내는 말([음악], (박수), 자막 인사 등)을 걸러 낸다. */
export function cleanTranscript(text: string): string {
  const t = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(시청해\s*주셔서\s*감사합니다|구독과\s*좋아요|MBC\s*뉴스|감사합니다)[.!\s]*$/.test(t)) return "";
  return t;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * 소리 파일을 글로 바꾼다. WAV(16kHz 모노)가 아니면 ffmpeg로 먼저 바꾼다.
 * command를 주면 그 명령을 Whisper 대신 쓴다(시험용).
 */
export async function transcribe(
  audio: Buffer,
  ext: string,
  s: VoiceSettings,
  setup: WhisperSetup,
  opts: { command?: CommandSpec; timeoutSec?: number; tmpDir?: string } = {},
): Promise<string> {
  const command = opts.command ?? setup.whisper;
  if (!command) throw new VoiceError("Whisper가 아직 없어요. 음성 비서 화면에서 'Whisper 설치'를 눌러 주세요.", 409);
  if (!setup.model && !opts.command) throw new VoiceError("Whisper 모델이 없어요. 음성 비서 화면에서 'Whisper 설치'를 눌러 주세요.", 409);
  const work = path.join(opts.tmpDir ?? os.tmpdir(), `nexus-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(work, { recursive: true });
  try {
    let wav = path.join(work, "in.wav");
    if (ext === ".wav") {
      writeFileSync(wav, audio);
    } else {
      if (!setup.ffmpeg) throw new VoiceError("음성 메시지를 바꾸려면 ffmpeg가 필요해요. PowerShell에서 'winget install Gyan.FFmpeg'를 실행한 뒤 Nexus를 다시 시작해 주세요.", 409);
      const src = path.join(work, `in${ext}`);
      writeFileSync(src, audio);
      wav = path.join(work, "conv.wav");
      const conv = await runProcess(setup.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { cwd: work, timeoutSec: 60 });
      if (conv.exitCode !== 0) throw new VoiceError(`소리 파일을 바꾸지 못했어요: ${conv.stderr.trim().slice(0, 200)}`);
    }
    const args = ["-f", wav, "-nt", "-np", "-l", s.language || "ko", "-t", String(Math.max(2, Math.min(8, os.cpus().length - 1)))];
    if (setup.model) args.unshift("-m", setup.model);
    // 호출어를 미리 알려 주면 잘 알아듣는다.
    if (s.wakeWord) args.push("--prompt", s.wakeWord);
    const res = await runProcess(command, args, { cwd: work, timeoutSec: opts.timeoutSec ?? 120 });
    if (res.spawnError) throw new VoiceError(`Whisper를 실행하지 못했어요: ${res.spawnError.message}`, 500);
    if (res.timedOut) throw new VoiceError("말을 글로 바꾸는 데 너무 오래 걸렸어요. 더 빠른 모델을 골라 보세요.", 504);
    if (res.exitCode !== 0) throw new VoiceError(`Whisper가 실패했어요: ${(res.stderr || res.stdout).trim().split(/\r?\n/).pop()?.slice(0, 200) ?? res.exitCode}`, 500);
    return cleanTranscript(res.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface InstallState {
  running: boolean;
  model: string | null;
  log: string[];
  error: string | null;
  finishedAt: string | null;
}

/** Windows에서 install-whisper.ps1을 돌려 Whisper와 모델을 받는다. */
export class WhisperInstaller {
  readonly state: InstallState = { running: false, model: null, log: [], error: null, finishedAt: null };

  constructor(private readonly script: string) {}

  start(model: string, dir: string): void {
    if (this.state.running) throw new VoiceError("이미 설치하고 있어요.", 409);
    if (!WHISPER_MODELS.some((m) => m.id === model)) throw new VoiceError("모델을 다시 골라 주세요.");
    if (process.platform !== "win32") throw new VoiceError("자동 설치는 Windows에서만 돼요. whisper.cpp를 직접 설치하고 경로를 적어 주세요.");
    if (!existsSync(this.script)) throw new VoiceError(`설치 스크립트를 찾지 못했어요: ${this.script}`, 500);
    Object.assign(this.state, { running: true, model, log: ["설치를 시작해요."], error: null, finishedAt: null });
    const child = startProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script, "-Model", model, "-Dest", dir], { cwd: os.homedir() });
    child.stdin?.end();
    const push = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) this.state.log.push(line.trim().slice(0, 300));
      }
      if (this.state.log.length > 40) this.state.log.splice(0, this.state.log.length - 40);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (err) => {
      Object.assign(this.state, { running: false, error: `설치를 시작하지 못했어요: ${err.message}`, finishedAt: new Date().toISOString() });
    });
    child.on("close", (code) => {
      Object.assign(this.state, {
        running: false,
        error: code === 0 ? null : `설치하지 못했어요 (${this.state.log.at(-1) ?? code}).`,
        finishedAt: new Date().toISOString(),
      });
    });
  }
}
