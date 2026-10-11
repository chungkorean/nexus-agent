import type { AdapterModel } from "./adapter-types.ts";

export const label = "Nexus 디스패처";

/** 모델은 에이전트마다 고정하지 않고 config/models.yaml의 별칭으로 작업마다 고른다. */
export const models: AdapterModel[] = [{ id: "auto", label: "자동 (정책 파일에 따라 작업마다 선택)" }];

export const agentConfigurationDoc = `# nexus_dispatch 에이전트 설정

코딩·터미널·로컬 파일 작업을 자동으로 OpenCode 또는 Claude Code에 맡기는 "개발 부서" 에이전트입니다.
이슈를 읽고 분류한 뒤, 작업 종류에 맞는 모델로 실행하고 결과를 이슈 댓글로 남깁니다.
비코딩 작업은 지정한 에이전트(예: Hermes)에게 하위 이슈로 넘깁니다.

쓰는 경우:
- 코드 작성·수정, 버그 수정, 테스트, 리팩터
- 스크립트 실행, 엑셀·CSV 파싱, APK 디컴파일 같은 터미널·파일 작업

쓰지 않는 경우:
- 기획, 세계관, 홍보 문구처럼 글만 쓰는 작업 (Hermes 같은 비코딩 에이전트가 적합)

설정 항목:
- cwd (필수): 작업 폴더의 전체 경로. git 저장소가 아니어도 됩니다.
- nonCodingAgentId: 비코딩 작업을 넘길 에이전트 ID
- configDir: models.yaml, routing.yaml이 있는 폴더. 기본값은 %LOCALAPPDATA%\\Nexus\\config
- opencodeCommand / claudeCommand: 실행 파일 경로 (기본값 opencode / claude)
- timeoutSec: 실행 제한 시간(초), 기본값 1800
- markDoneOnSuccess: 성공하면 이슈를 done으로 바꿀지, 기본값 false
`;
