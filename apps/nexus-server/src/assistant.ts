// 음성 비서와 텔레그램이 함께 쓰는 말 처리: 할 일 등록, 진행 상황 브리핑, 사용량, 도움말.
import { PaperclipClient, type PaperclipIssue } from "@nexus/paperclip-client";
import { listArchive, readTelegramSettings } from "@nexus/shared";
import { readVoiceSettings } from "./voice.ts";

export interface AssistantDeps {
  stateDir: string;
  paperclipUrl: string;
  /** 이번 달 사용량 한 단락 */
  usageText: () => string;
  /** 오늘 쓴 비용 */
  todayCost?: () => number;
}

export type Intent = "briefing" | "usage" | "help" | "task";

export interface AssistantReply {
  intent: Intent;
  /** 화면과 텔레그램에 보여 줄 글 */
  text: string;
  /** 소리로 읽어 줄 글 (짧게) */
  speech: string;
  issue?: { id: string; identifier: string | null; title: string };
}

export class AssistantError extends Error {}

const BRIEFING = /(진행\s*상황|현황|브리핑|상황\s*(알려|보고|어때|좀)|어떻게\s*(돼|되|됐)|뭐\s*하고\s*있|요즘\s*일|일\s*어떻게|status|briefing)/i;
const USAGE = /(사용량|얼마나\s*(썼|쓴)|비용|요금|usage)/i;
const HELP = /^(도움말|도와\s*줘|뭘?\s*할\s*수\s*있|무엇을\s*할\s*수|사용법|help)/i;

/** 짧은 말에서만 명령을 찾는다. 긴 말은 할 일로 본다. */
export function detectIntent(text: string): Intent {
  const t = text.trim();
  if (t.length <= 40 && HELP.test(t)) return "help";
  if (t.length <= 40 && USAGE.test(t)) return "usage";
  if (t.length <= 40 && BRIEFING.test(t)) return "briefing";
  return "task";
}

export const HELP_TEXT = [
  "이렇게 말해 보세요.",
  "• \"로그인 화면에 비밀번호 찾기 추가해 줘\" 같은 할 일은 Paperclip 이슈로 등록해요.",
  "• \"진행 상황 알려 줘\"는 진행 중인 일과 오늘 끝낸 일을 알려 드려요.",
  "• \"사용량 알려 줘\"는 이번 달 사용량을 알려 드려요.",
].join("\n");

/** 새 일을 맡길 회사·에이전트. 음성은 음성 설정을, 없으면 텔레그램 설정을 쓴다. */
export function intakeTarget(stateDir: string, source: "voice" | "telegram"): { companyId: string; agentId: string } | null {
  const v = source === "voice" ? readVoiceSettings(stateDir) : null;
  if (v?.companyId && v.agentId) return { companyId: v.companyId, agentId: v.agentId };
  const tg = readTelegramSettings(stateDir);
  return tg.companyId && tg.agentId ? { companyId: tg.companyId, agentId: tg.agentId } : null;
}

const SOURCE_LABEL = { voice: "음성으로 보냄", telegram: "텔레그램에서 보냄" } as const;

/** 말 한 덩어리를 이슈로 만든다. 첫 줄(또는 첫 문장)이 제목이다. */
export async function createTaskIssue(deps: AssistantDeps, text: string, source: "voice" | "telegram", target = intakeTarget(deps.stateDir, source)): Promise<PaperclipIssue> {
  if (!target) {
    throw new AssistantError(
      source === "voice"
        ? "일을 맡길 Paperclip 회사와 에이전트를 아직 고르지 않았어요. 음성 비서 화면의 '일 맡길 곳'에서 골라 주세요."
        : "일을 맡길 Paperclip 회사와 에이전트를 아직 고르지 않았어요. 설정 화면의 '텔레그램' 칸에서 골라 주세요.",
    );
  }
  const [firstLine, ...restLines] = text.trim().split(/\r?\n/);
  let title = firstLine!.trim();
  let rest = restLines.join("\n").trim();
  // 음성은 한 줄로 오므로 첫 문장을 제목으로 쓴다.
  if (!rest && title.length > 60) {
    const m = title.match(/^(.{8,80}?[.!?。])\s+(.+)$/s);
    if (m) {
      title = m[1]!;
      rest = m[2]!;
    }
  }
  const long = title.length > 120;
  const description = [rest, long ? title : "", `_(${SOURCE_LABEL[source]})_`].filter(Boolean).join("\n\n");
  title = title.slice(0, 120).replace(/[.。]$/, "") || "새 할 일";
  const client = new PaperclipClient(deps.paperclipUrl, undefined, "");
  try {
    return await client.createIssue(target.companyId, { title, description, status: "todo", assigneeAgentId: target.agentId });
  } catch (err) {
    const offline = !/→ \d{3}/.test((err as Error).message);
    throw new AssistantError(offline ? "Paperclip에 연결하지 못했어요. PC에서 Paperclip이 켜져 있는지 확인해 주세요." : `이슈를 만들지 못했어요: ${(err as Error).message}`);
  }
}

const OPEN_STATUS: Record<string, string> = { in_progress: "진행 중", todo: "할 일", blocked: "막힘", in_review: "검토 중" };

function names(items: Array<{ identifier?: string | null; title?: string | null }>, max = 3): string {
  const shown = items.slice(0, max).map((i) => `${i.identifier ? `${i.identifier} ` : ""}${(i.title ?? "").slice(0, 40)}`);
  return shown.join(", ") + (items.length > max ? ` 외 ${items.length - max}개` : "");
}

/** 진행 중인 일(Paperclip)과 오늘 끝낸 일(보관함)을 짧게 정리한다. */
export async function briefing(deps: AssistantDeps, now = new Date()): Promise<{ text: string; speech: string }> {
  const lines: string[] = [];
  const speech: string[] = [];
  const target = intakeTarget(deps.stateDir, "voice");
  if (target) {
    try {
      const client = new PaperclipClient(deps.paperclipUrl, undefined, "");
      const issues = await client.listIssues(target.companyId);
      const open = (Array.isArray(issues) ? issues : []).filter((i) => i.status && OPEN_STATUS[i.status] && !i.parentId);
      const by = (s: string) => open.filter((i) => i.status === s);
      const running = by("in_progress");
      const blocked = by("blocked");
      const todo = by("todo");
      if (!open.length) {
        lines.push("진행 중이거나 기다리는 일이 없어요.");
        speech.push("진행 중인 일은 없어요.");
      } else {
        if (running.length) lines.push(`진행 중 ${running.length}개: ${names(running)}`);
        if (todo.length) lines.push(`기다리는 일 ${todo.length}개: ${names(todo)}`);
        if (blocked.length) lines.push(`막힌 일 ${blocked.length}개: ${names(blocked)}`);
        speech.push(`진행 중 ${running.length}개, 기다리는 일 ${todo.length}개${blocked.length ? `, 막힌 일 ${blocked.length}개` : ""}가 있어요.`);
      }
    } catch {
      lines.push("Paperclip에 연결하지 못해 진행 중인 일은 확인하지 못했어요.");
      speech.push("Paperclip에 연결하지 못했어요.");
    }
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = listArchive(deps.stateDir, { limit: 300 }).filter((r) => Date.parse(r.at) >= start.getTime());
  if (today.length) {
    const counts = new Map<string, number>();
    for (const r of today) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    const parts = [...counts].map(([s, n]) => `${s} ${n}`).join(", ");
    lines.push(`오늘 끝난 작업 ${today.length}개 (${parts}). 최근: ${names(today, 2)}`);
    speech.push(`오늘 끝난 작업은 ${today.length}개예요. ${parts}.`);
    const attention = today.filter((r) => r.status !== "완료");
    if (attention.length) lines.push(`확인이 필요한 결과: ${names(attention)}`);
  } else {
    lines.push("오늘 끝난 작업은 아직 없어요.");
    speech.push("오늘 끝난 작업은 아직 없어요.");
  }
  const cost = deps.todayCost?.();
  if (cost !== undefined) lines.push(`오늘 쓴 비용: $${cost.toFixed(2)}`);
  return { text: lines.join("\n"), speech: speech.join(" ") };
}

/** 말 한 덩어리에 답한다. 할 일이면 이슈를 만든다. */
export async function respond(deps: AssistantDeps, text: string, source: "voice" | "telegram"): Promise<AssistantReply> {
  const intent = detectIntent(text);
  if (intent === "help") return { intent, text: HELP_TEXT, speech: "할 일을 말하면 이슈로 등록하고, 진행 상황이나 사용량을 물으면 알려 드려요." };
  if (intent === "usage") {
    const t = deps.usageText();
    return { intent, text: t, speech: t.split("\n")[0]!.replace(/\$/g, "달러 ") };
  }
  if (intent === "briefing") {
    const b = await briefing(deps);
    return { intent, text: b.text, speech: b.speech };
  }
  const issue = await createTaskIssue(deps, text, source);
  const ident = issue.identifier ?? null;
  return {
    intent,
    text: `${ident ?? "새 이슈"}로 등록했어요: ${issue.title}`,
    speech: `${ident ? ident.replace(/-/g, " ") + "번으로 " : ""}등록했어요.`,
    issue: { id: issue.id, identifier: ident, title: issue.title },
  };
}
