/** 실행 엔진. Claude 구독 계정은 claude-code, 나머지 공급자는 opencode로 실행한다. */
export type Engine = "opencode" | "claude-code";

/** 분류기가 판정하는 작업 종류. 라우팅 정책의 키가 된다. */
export type TaskType =
  | "design"
  | "implement"
  | "refactor"
  | "test"
  | "review"
  | "docs"
  | "research"
  | "ops";

export type Risk = "low" | "high";

export interface Classification {
  /** execute: OpenCode·Claude Code가 처리할 작업, delegate: 비코딩 에이전트에게 넘길 작업 */
  decision: "execute" | "delegate";
  taskType: TaskType;
  risk: Risk;
  /** 판정 근거. 이슈 댓글에 그대로 남겨 사람이 바로잡을 수 있게 한다. */
  reasons: string[];
}

export interface ModelAlias {
  engine: Engine;
  /** opencode는 provider/model, claude-code는 opus·sonnet·haiku 또는 전체 모델 ID */
  model: string;
  /** 화면 표시용 이름 */
  label?: string;
  /** Claude Code 설정 폴더(CLAUDE_CONFIG_DIR) 또는 OpenCode 데이터 폴더(XDG_DATA_HOME). 계정 분리용 */
  accountDir?: string;
}

export interface Route {
  alias: string;
  engine: Engine;
  model: string;
  accountDir?: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface ChangedFile {
  file: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

/** 공급자 쪽 문제(한도 초과, 로그인 만료 등)는 대체 순서의 다음 별칭으로 넘길 수 있다. */
export type ErrorFamily = "provider_quota" | "provider_auth" | "provider_unavailable" | "task_failed" | "timeout" | "spawn_failed";

export interface RunRequest {
  cwd: string;
  prompt: string;
  model: string;
  accountDir?: string;
  timeoutSec: number;
  env?: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface RunOutcome {
  ok: boolean;
  engine: Engine;
  model: string;
  provider?: string;
  summary: string;
  usage?: UsageSummary;
  costUsd?: number | null;
  sessionId?: string | null;
  changedFiles: ChangedFile[];
  errorMessage?: string;
  errorFamily?: ErrorFamily;
  timedOut?: boolean;
}

export interface Executor {
  engine: Engine;
  run(req: RunRequest): Promise<RunOutcome>;
}
