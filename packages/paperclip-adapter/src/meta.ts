import type { AdapterConfigSchema, AdapterModel } from "./adapter-types.ts";

export const label = "Nexus 디스패처";

/** 모델은 에이전트마다 고정하지 않고 config/models.yaml의 별칭으로 작업마다 고른다. */
export const models: AdapterModel[] = [{ id: "auto", label: "자동 (정책 파일에 따라 작업마다 선택)" }];

export const agentConfigurationDoc = `# nexus_dispatch 에이전트 설정

코딩·터미널·로컬 파일 작업을 자동으로 OpenCode 또는 Claude Code에 맡기는 "개발 부서" 에이전트입니다.
이슈를 읽고 분류한 뒤, 작업 종류에 맞는 모델로 실행하고 결과를 이슈 댓글로 남깁니다.
큰 이슈는 하위 작업으로 나눠 하위 이슈로 보여 주고, 여러 모델·계정에 동시에 맡깁니다.
비코딩 작업은 지정한 에이전트(예: Hermes)에게 하위 이슈로 넘깁니다.

쓰는 경우:
- 코드 작성·수정, 버그 수정, 테스트, 리팩터
- 스크립트 실행, 엑셀·CSV 파싱, APK 디컴파일 같은 터미널·파일 작업

쓰지 않는 경우:
- 기획, 세계관, 홍보 문구처럼 글만 쓰는 작업 (Hermes 같은 비코딩 에이전트가 적합)

설정 항목:
- cwd (필수): 작업 폴더의 전체 경로. git 저장소가 아니어도 됩니다.
- nonCodingAgentId: 비코딩 작업을 넘길 에이전트 ID
- configDir: models.yaml, routing.yaml, accounts.yaml이 있는 폴더. 기본값은 %LOCALAPPDATA%\\Nexus\\config
- stateDir / accountsDir / worktreeRoot: 계정 한도 상태, 계정 로그인 폴더, 병렬 실행용 작업 폴더. 기본값은 %LOCALAPPDATA%\\Nexus 아래
- opencodeCommand / claudeCommand: 실행 파일 경로 (기본값 opencode / claude)
- timeoutSec: 실행 한 번(하위 작업 하나)의 제한 시간(초), 기본값 1800
- autoMerge: 하위 작업이 모두 성공하면 브랜치를 작업 폴더의 현재 브랜치에 합칠지, 기본값 true. 커밋하지 않은 변경이 있거나 충돌하면 합치지 않고 명령만 알려 줘요.
- markDoneOnSuccess: 성공하면 이슈를 done으로 바꿀지, 기본값 true. 실패하면 항상 blocked로 바꿔요.
`;

/** Paperclip 에이전트 설정 화면에 보일 입력칸. 키는 settings.ts의 readSettings가 읽는 이름과 같다. */
export const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "cwd",
      label: "작업 폴더",
      type: "text",
      required: true,
      hint: "AI가 작업할 폴더의 전체 경로. 예: C:\\work\\my-project",
    },
    {
      key: "nonCodingAgentId",
      label: "비코딩 작업을 넘길 에이전트 ID",
      type: "text",
      hint: "기획·글쓰기 같은 작업을 맡길 에이전트(예: Hermes)의 ID. 비워 두면 모두 직접 실행해요.",
    },
    {
      key: "timeoutSec",
      label: "작업 하나의 제한 시간(초)",
      type: "number",
      default: 1800,
      hint: "하위 작업 하나가 이 시간을 넘기면 멈춰요.",
    },
    {
      key: "markDoneOnSuccess",
      label: "성공하면 이슈를 완료로 바꾸기",
      type: "toggle",
      default: true,
      hint: "끄면 성공해도 진행 중으로 남아요. 실패하면 항상 '막힘'으로 바꿔요.",
    },
    {
      key: "autoMerge",
      label: "성공하면 결과를 작업 폴더에 자동으로 합치기",
      type: "toggle",
      default: true,
      hint: "하위 작업이 모두 성공했을 때만 합쳐요. 커밋하지 않은 변경이 있거나 충돌하면 합치지 않고 명령만 알려 줘요.",
    },
    { key: "configDir", label: "설정 폴더", type: "text", group: "고급", hint: "비워 두면 %LOCALAPPDATA%\\Nexus\\config" },
    { key: "opencodeCommand", label: "opencode 실행 파일", type: "text", group: "고급", hint: "비워 두면 opencode" },
    { key: "claudeCommand", label: "claude 실행 파일", type: "text", group: "고급", hint: "비워 두면 claude" },
  ],
};
