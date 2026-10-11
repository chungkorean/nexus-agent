import type { Classification, Risk, TaskType } from "@nexus/shared";

export interface ClassifyInput {
  title: string;
  description?: string | null;
  labels?: string[];
}

export interface ClassifyOptions {
  defaultWhenUnsure: "execute" | "delegate";
}

/**
 * 규칙 기반 1단계 분류기. 모델 호출 없이 동작한다.
 * 한국어는 조사·어미가 붙으므로 부분 일치, 영어는 단어 경계로 찾는다.
 * 라벨이 있으면 라벨이 키워드보다 우선한다.
 */

const EXECUTE_LABELS = ["code", "coding", "exec", "dev", "코딩", "개발", "실행"];
const DELEGATE_LABELS = ["no-code", "non-coding", "비코딩"];

type Signal = { ko?: string[]; en?: string[]; weight: number };

const EXECUTE_SIGNALS: Signal[] = [
  {
    weight: 2,
    ko: ["코드", "버그", "스크립트", "터미널", "명령어", "디컴파일", "빌드", "컴파일", "리팩터", "리팩토링", "함수", "클래스", "파싱", "저장소", "커밋", "에러 로그", "오류 로그", "파이썬", "자바스크립트", "타입스크립트", "정규식"],
    en: ["code", "bug", "script", "terminal", "cli", "compile", "build", "refactor", "function", "class", "parse", "parsing", "repo", "repository", "commit", "stack trace", "python", "javascript", "typescript", "sql", "regex", "jadx", "git", "npm", "pip", "api", "decompile", "unit test"],
  },
  {
    weight: 1,
    ko: ["구현", "수정", "자동화", "엑셀", "파일", "폴더", "데이터", "설치", "배포", "테스트", "로그", "설정 변경"],
    en: ["implement", "fix", "automate", "excel", "file", "folder", "data", "install", "deploy", "test", "log"],
  },
];

const DELEGATE_SIGNALS: Signal[] = [
  {
    weight: 2,
    ko: ["세계관", "스토리", "플롯", "시놉시스", "캐릭터 설정", "콘셉트 아트", "홍보 문구", "광고 문구", "카피", "이미지 생성", "일러스트", "웹툰 콘티"],
    en: ["storyline", "worldbuilding", "plot", "copywriting", "illustration", "image generation"],
  },
  {
    weight: 1,
    ko: ["기획", "시나리오", "캐릭터", "홍보", "마케팅", "문구", "요금제", "브리핑", "번역", "아이디어", "이메일", "블로그", "기사", "보도자료", "일정"],
    en: ["marketing", "slogan", "translate", "translation", "brainstorm", "email", "blog", "press release", "schedule"],
  },
];

const TASK_TYPE_RULES: Array<{ type: TaskType; ko: string[]; en: string[] }> = [
  { type: "review", ko: ["코드 리뷰", "리뷰", "검토"], en: ["review"] },
  { type: "test", ko: ["테스트 작성", "테스트 추가", "단위 테스트", "테스트 코드"], en: ["write tests", "add tests", "unit test", "test coverage"] },
  { type: "refactor", ko: ["리팩터", "리팩토링", "코드 정리"], en: ["refactor", "clean up"] },
  { type: "design", ko: ["설계", "아키텍처", "구조 잡"], en: ["architecture", "system design"] },
  { type: "docs", ko: ["문서화", "문서 작성", "readme", "주석"], en: ["readme", "documentation", "docs", "docstring"] },
  { type: "research", ko: ["원인 분석", "원인을 찾", "조사", "코드베이스 분석", "왜 "], en: ["investigate", "root cause", "research", "why "] },
  {
    type: "ops",
    ko: ["실행해", "설치", "터미널", "명령어", "파싱", "엑셀", "디컴파일", "데이터 분석", "자동화", "배포", "추출"],
    en: ["run ", "install", "terminal", "parse", "excel", "decompile", "deploy", "extract", "automate"],
  },
];

const HIGH_RISK = {
  ko: ["인증", "로그인", "결제", "비밀번호", "마이그레이션", "삭제", "보안", "권한", "운영 서버", "개인정보"],
  en: ["auth", "login", "payment", "password", "migration", "secret", "production", "drop table", "credential"],
};

function containsKo(text: string, word: string): boolean {
  return text.includes(word.toLowerCase());
}

function containsEn(text: string, word: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}`, "i").test(text);
}

function matches(text: string, ko: string[] = [], en: string[] = []): string[] {
  return [...ko.filter((w) => containsKo(text, w)), ...en.filter((w) => containsEn(text, w))];
}

function score(text: string, signals: Signal[]): { total: number; hits: string[] } {
  let total = 0;
  const hits: string[] = [];
  for (const s of signals) {
    const found = matches(text, s.ko, s.en);
    total += found.length * s.weight;
    hits.push(...found);
  }
  return { total, hits };
}

const FILE_PATTERN = /[\w\-./\\]+\.(py|ts|tsx|js|jsx|mjs|cjs|cs|java|kt|go|rs|cpp|c|h|json|ya?ml|toml|sql|sh|ps1|bat|apk|xlsx?|csv|bundle|dll|exe)\b/i;

export function classify(input: ClassifyInput, opts: ClassifyOptions): Classification {
  const text = `${input.title}\n${input.description ?? ""}`.toLowerCase();
  const labels = (input.labels ?? []).map((l) => l.trim().toLowerCase());
  const reasons: string[] = [];

  let decision: "execute" | "delegate";
  const execLabel = labels.find((l) => EXECUTE_LABELS.includes(l));
  const delegLabel = labels.find((l) => DELEGATE_LABELS.includes(l));
  if (delegLabel) {
    decision = "delegate";
    reasons.push(`라벨 "${delegLabel}"`);
  } else if (execLabel) {
    decision = "execute";
    reasons.push(`라벨 "${execLabel}"`);
  } else {
    const exec = score(text, EXECUTE_SIGNALS);
    const deleg = score(text, DELEGATE_SIGNALS);
    if (text.includes("```")) {
      exec.total += 3;
      exec.hits.push("코드 블록");
    }
    const file = text.match(FILE_PATTERN);
    if (file) {
      exec.total += 2;
      exec.hits.push(`파일 ${file[0]}`);
    }
    if (exec.total > deleg.total) {
      decision = "execute";
      reasons.push(`실행 작업 신호 ${exec.total}점 (${unique(exec.hits).join(", ")})`);
      if (deleg.total) reasons.push(`비코딩 신호 ${deleg.total}점 (${unique(deleg.hits).join(", ")})`);
    } else if (deleg.total > exec.total) {
      decision = "delegate";
      reasons.push(`비코딩 신호 ${deleg.total}점 (${unique(deleg.hits).join(", ")})`);
      if (exec.total) reasons.push(`실행 작업 신호 ${exec.total}점 (${unique(exec.hits).join(", ")})`);
    } else {
      decision = opts.defaultWhenUnsure;
      reasons.push(
        exec.total === 0
          ? `분류 신호가 없어 기본값(${opts.defaultWhenUnsure === "execute" ? "실행" : "위임"})을 따름`
          : `실행·비코딩 신호가 같아(${exec.total}점) 기본값을 따름`,
      );
    }
  }

  const taskType = detectTaskType(text);
  const riskHits = matches(text, HIGH_RISK.ko, HIGH_RISK.en);
  const risk: Risk = riskHits.length ? "high" : "low";
  if (risk === "high") reasons.push(`위험도 높음 (${unique(riskHits).join(", ")})`);

  return { decision, taskType, risk, reasons };
}

export function detectTaskType(lowerText: string): TaskType {
  for (const rule of TASK_TYPE_RULES) {
    if (matches(lowerText, rule.ko, rule.en).length) return rule.type;
  }
  return "implement";
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
