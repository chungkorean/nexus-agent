// 작업 기록 보관함: 끝난 작업마다 결과, 이슈 내용, 만든 이미지·오디오를 폴더 하나에 남긴다.
// 스튜디오 화면이 이 폴더를 읽고, 지난 작업을 이어서 맡길 때도 쓴다.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type MediaKind = "image" | "audio" | "video";

const MEDIA_EXT: Record<string, { kind: MediaKind; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".svg": { kind: "image", mime: "image/svg+xml" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mov": { kind: "video", mime: "video/quicktime" },
};

export const MAX_MEDIA_FILES = 60;
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export function mediaInfo(file: string): { kind: MediaKind; mime: string } | null {
  return MEDIA_EXT[path.extname(file).toLowerCase()] ?? null;
}

export interface ArchiveMedia {
  /** 보관함 폴더 안 media/ 아래 파일 이름 */
  name: string;
  /** 작업 폴더 기준 원래 경로 */
  source: string;
  kind: MediaKind;
  bytes: number;
}

export interface ArchiveRecord {
  /** 폴더 이름. 시각-이슈번호 */
  id: string;
  at: string;
  issueId: string;
  identifier: string | null;
  title: string;
  companyId: string | null;
  /** 결과 제목에서 읽은 상태: 완료, 확인 필요, 실패 등 */
  status: string;
  cwd: string | null;
  models: string[];
  costUsd: number;
  media: ArchiveMedia[];
}

export interface ArchiveSummary extends ArchiveRecord {
  /** 결과 본문 첫 몇 줄 (목록용) */
  preview: string;
}

/** 미디어를 가져올 곳. ref가 있으면 그 git 브랜치에서, 없으면 폴더의 파일을 읽는다. */
export interface MediaSource {
  root: string;
  files?: string[];
  ref?: string;
  /** ref와 함께 주면 base..ref에서 바뀐 파일을 git으로 찾는다 */
  base?: string;
}

export interface ArchiveInput {
  issue: { id: string; identifier?: string | null; title?: string | null; description?: string | null; companyId?: string | null };
  body: string;
  cwd?: string | null;
  models?: string[];
  costUsd?: number;
  media?: MediaSource[];
  now?: Date;
}

export function archiveDir(stateDir: string): string {
  return path.join(stateDir, "archive");
}

const ARCHIVE_ID = /^[0-9]{8}-[0-9]{6}-[A-Za-z0-9_-]{1,60}$/;

export function isArchiveId(id: string): boolean {
  return ARCHIVE_ID.test(id);
}

/** 결과 댓글 첫 줄("### Nexus 실행 결과: 완료")에서 상태를 읽는다. */
export function resultStatus(body: string): string {
  const first = (body.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  const m = first.match(/결과:\s*(.+)$/);
  if (m) return m[1]!.trim();
  if (/못했어요|실패/.test(first)) return "실패";
  return first.slice(0, 40) || "기록";
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitBuffer(root: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, encoding: "buffer", maxBuffer: MAX_MEDIA_BYTES + 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function changedBetween(root: string, base: string, ref: string): Promise<string[]> {
  const out = await gitBuffer(root, ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=AMR", `${base}..${ref}`]);
  return out ? out.toString("utf8").split(/\r?\n/).filter(Boolean) : [];
}

function repoTop(dir: string): string | null {
  let cur = path.resolve(dir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function cleanPath(file: string): string {
  return file.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

/**
 * 결과 하나를 보관함에 남긴다. 실패해도 실행을 막지 않도록 부르는 쪽에서 오류를 삼킨다.
 * 같은 이슈를 여러 번 실행하면 실행마다 폴더가 따로 생긴다.
 */
export async function archiveRun(stateDir: string, input: ArchiveInput): Promise<ArchiveRecord> {
  const now = input.now ?? new Date();
  const ident = (input.issue.identifier ?? input.issue.id).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "issue";
  const root = archiveDir(stateDir);
  mkdirSync(root, { recursive: true });
  let id = `${stamp(now)}-${ident}`;
  for (let i = 2; existsSync(path.join(root, id)); i++) id = `${stamp(now)}-${ident}-${i}`.slice(0, 76);
  const tmp = path.join(root, `.${id}.tmp`);
  mkdirSync(path.join(tmp, "media"), { recursive: true });

  const media: ArchiveMedia[] = [];
  const usedNames = new Set<string>();
  const seen = new Set<string>();
  for (const src of input.media ?? []) {
    let files = (src.files ?? []).map(cleanPath);
    if (!src.files && src.ref && src.base) files = await changedBetween(src.root, src.base, src.ref);
    for (const file of files) {
      if (media.length >= MAX_MEDIA_FILES) break;
      const info = mediaInfo(file);
      if (!info || seen.has(file)) continue;
      let data: Buffer | null = null;
      if (src.ref) {
        data = await gitBuffer(src.root, ["show", `${src.ref}:${file}`]);
      } else {
        // git status는 저장소 맨 위 기준 경로를 주므로, 작업 폴더에 없으면 저장소 맨 위에서 찾는다.
        const top = repoTop(src.root);
        const full = [path.resolve(src.root, file), ...(top ? [path.resolve(top, file)] : [])].find((f) => existsSync(f));
        if (!full || !full.startsWith(path.resolve(top ?? src.root) + path.sep)) continue;
        try {
          const st = statSync(full);
          if (!st.isFile() || st.size > MAX_MEDIA_BYTES) continue;
          data = readFileSync(full);
        } catch {
          continue;
        }
      }
      if (!data || data.length > MAX_MEDIA_BYTES) continue;
      seen.add(file);
      const base = path.basename(file).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80) || `file${path.extname(file)}`;
      let name = base;
      for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${i}-${base}`;
      usedNames.add(name.toLowerCase());
      writeFileSync(path.join(tmp, "media", name), data);
      media.push({ name, source: file, kind: info.kind, bytes: data.length });
    }
  }

  const record: ArchiveRecord = {
    id,
    at: now.toISOString(),
    issueId: input.issue.id,
    identifier: input.issue.identifier ?? null,
    title: input.issue.title ?? "",
    companyId: input.issue.companyId ?? null,
    status: resultStatus(input.body),
    cwd: input.cwd ?? null,
    models: [...new Set(input.models ?? [])],
    costUsd: input.costUsd ?? 0,
    media,
  };
  writeFileSync(path.join(tmp, "run.json"), JSON.stringify(record, null, 2));
  writeFileSync(path.join(tmp, "result.md"), input.body);
  writeFileSync(path.join(tmp, "issue.md"), `# ${input.issue.identifier ? `${input.issue.identifier} ` : ""}${input.issue.title ?? ""}\n\n${input.issue.description ?? ""}\n`);
  renameSync(tmp, path.join(root, id));
  return record;
}

function readRecord(dir: string): ArchiveRecord | null {
  try {
    const r = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as ArchiveRecord;
    return r && typeof r.id === "string" && Array.isArray(r.media) ? r : null;
  } catch {
    return null;
  }
}

/** 보관함 목록, 최근 것부터. q는 이슈 번호·제목·모델·상태에서 찾는다. */
export function listArchive(stateDir: string, opts: { q?: string; limit?: number; mediaOnly?: boolean } = {}): ArchiveSummary[] {
  const root = archiveDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(root).filter(isArchiveId).sort().reverse();
  } catch {
    return [];
  }
  const q = opts.q?.trim().toLowerCase();
  const out: ArchiveSummary[] = [];
  for (const name of names) {
    if (out.length >= (opts.limit ?? 200)) break;
    const r = readRecord(path.join(root, name));
    if (!r) continue;
    if (opts.mediaOnly && !r.media.length) continue;
    if (q && ![r.identifier, r.title, r.status, ...r.models].join(" ").toLowerCase().includes(q)) continue;
    let preview = "";
    try {
      preview = readFileSync(path.join(root, name, "result.md"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("- "))
        .slice(0, 2)
        .join(" ")
        .slice(0, 240);
    } catch {
      /* 본문이 없어도 목록에는 보인다 */
    }
    out.push({ ...r, preview });
  }
  return out;
}

export function readArchive(stateDir: string, id: string): { record: ArchiveRecord; result: string; issue: string } | null {
  if (!isArchiveId(id)) return null;
  const dir = path.join(archiveDir(stateDir), id);
  const record = readRecord(dir);
  if (!record) return null;
  const read = (f: string) => {
    try {
      return readFileSync(path.join(dir, f), "utf8");
    } catch {
      return "";
    }
  };
  return { record, result: read("result.md"), issue: read("issue.md") };
}

/** 보관함의 미디어 파일 경로. 이름이 기록에 없으면 null */
export function archiveMediaPath(stateDir: string, id: string, name: string): string | null {
  const found = readArchive(stateDir, id);
  if (!found || !found.record.media.some((m) => m.name === name)) return null;
  return path.join(archiveDir(stateDir), id, "media", name);
}

export function removeArchive(stateDir: string, id: string): boolean {
  if (!isArchiveId(id)) return false;
  const dir = path.join(archiveDir(stateDir), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

