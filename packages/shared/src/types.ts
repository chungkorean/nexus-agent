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
  /** 계정 폴더를 직접 지정할 때. 보통은 accounts로 계정 ID를 지정한다. */
  accountDir?: string;
  /** accounts.yaml의 계정 ID. 여러 개면 앞에서부터 쓰고 한도에 걸린 계정은 건너뛴다. */
  accounts?: string[];
}

/** 로그인해 둔 AI 계정 하나. 계정마다 폴더를 따로 두어 같은 서비스 계정도 여러 개 쓸 수 있다. */
export interface Account {
  id: string;
  engine: Engine;
  /** 화면 표시용: anthropic, openai, google, github-copilot, ollama 등 */
  provider: string;
  label: string;
  /** Claude Code는 CLAUDE_CONFIG_DIR, OpenCode는 XDG_DATA_HOME으로 넘기는 폴더 */
  dir: string;
  /** 월 예산(달러). 넘으면 그달에는 이 계정을 건너뛰고 대체 순서의 다음으로 넘어간다. */
  monthlyBudgetUsd?: number;
  /** 월 토큰 한도(입력+출력). 구독 계정처럼 비용이 0으로 찍히는 계정에 쓴다. */
  monthlyTokenLimit?: number;
}

export interface Route {
  alias: string;
  engine: Engine;
  model: string;
  accountDir?: string;
  accountId?: string;
  accountLabel?: string;
}

/** 플래너가 나눈 하위 작업 하나 */
export interface Subtask {
  key: string;
  title: string;
  instructions: string;
  taskType: TaskType;
  /** 이 작업이 주로 건드릴 파일·폴더. 겹치면 동시에 돌리지 않는다. */
  files: string[];
  dependsOn: string[];
}

export interface Plan {
  summary: string;
  subtasks: Subtask[];
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
  /** true면 파일을 고치지 않고 읽기만 한다 (작업 분해용) */
  readOnly?: boolean;
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
