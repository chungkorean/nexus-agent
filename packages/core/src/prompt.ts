import type { Classification, Subtask } from "@nexus/shared";

export interface PromptInput {
  identifier?: string | null;
  title: string;
  description?: string | null;
  classification: Classification;
  cwd: string;
}

const TASK_TYPE_KO: Record<string, string> = {
  design: "설계",
  implement: "구현",
  refactor: "리팩터",
  test: "테스트 작성",
  review: "리뷰",
  docs: "문서",
  research: "조사·분석",
  ops: "터미널·파일 작업",
};

const SUMMARY_FORMAT = [
  "## 마지막 응답 형식",
  "작업이 끝나면 한국어로 다음을 짧게 적어 주세요.",
  "1. 무엇을 했는지 (두세 문장)",
  "2. 바뀐 파일 또는 만든 결과물",
  "3. 확인한 방법과 결과",
  "4. 사람이 확인해야 할 점 (없으면 \"없음\")",
];

/** 실행 엔진에 넘길 지시문. 마지막 요약 형식을 정해 두어 Paperclip 댓글로 그대로 옮긴다. */
export function buildPrompt(p: PromptInput): string {
  const head = p.identifier ? `[${p.identifier}] ${p.title}` : p.title;
  return [
    `Paperclip 이슈를 처리해 주세요: ${head}`,
    "",
    "## 이슈 내용",
    p.description?.trim() || "(설명 없음)",
    "",
    "## 작업 조건",
    `- 작업 폴더: ${p.cwd}`,
    `- 작업 종류: ${TASK_TYPE_KO[p.classification.taskType] ?? p.classification.taskType}`,
    p.classification.risk === "high"
      ? "- 위험도 높음: 인증·결제·데이터 삭제 등에 닿는 변경은 최소화하고, 되돌리기 어려운 명령은 실행하지 마세요."
      : "- 작업 폴더 밖의 파일은 건드리지 마세요.",
    "- 테스트나 실행으로 결과를 확인할 수 있으면 확인하세요.",
    "",
    ...SUMMARY_FORMAT,
  ].join("\n");
}

export interface SubtaskPromptInput {
  identifier?: string | null;
  parentTitle: string;
  planSummary: string;
  subtask: Subtask;
  others: Subtask[];
  risk: Classification["risk"];
  cwd: string;
}

/** 하위 작업 하나의 지시문. 다른 작업자가 같은 시간에 무엇을 하는지 알려 겹치지 않게 한다. */
export function buildSubtaskPrompt(p: SubtaskPromptInput): string {
  const head = p.identifier ? `[${p.identifier}] ${p.parentTitle}` : p.parentTitle;
  const s = p.subtask;
  return [
    `Paperclip 이슈 ${head}의 하위 작업을 맡았어요: ${s.title}`,
    `하위 작업 키: ${s.key}`,
    "",
    "## 할 일",
    s.instructions,
    "",
    "## 전체 계획",
    p.planSummary || "(요약 없음)",
    ...p.others.map((o) => `- ${o.key}: ${o.title}${o.files.length ? ` (${o.files.join(", ")})` : ""}`),
    "",
    "## 작업 조건",
    `- 작업 폴더: ${p.cwd}`,
    `- 작업 종류: ${TASK_TYPE_KO[s.taskType] ?? s.taskType}`,
    s.files.length ? `- 주로 고칠 파일: ${s.files.join(", ")}. 다른 작업이 맡은 파일은 고치지 마세요.` : "- 다른 하위 작업이 맡은 파일은 고치지 마세요.",
    p.risk === "high"
      ? "- 위험도 높음: 인증·결제·데이터 삭제 등에 닿는 변경은 최소화하고, 되돌리기 어려운 명령은 실행하지 마세요."
      : "- 작업 폴더 밖의 파일은 건드리지 마세요.",
    "- git 커밋은 하지 마세요. Nexus가 끝난 뒤 커밋합니다.",
    "- 테스트나 실행으로 결과를 확인할 수 있으면 확인하세요.",
    "",
    ...SUMMARY_FORMAT,
  ].join("\n");
}
