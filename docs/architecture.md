# 아키텍처

전체 설계는 [Nexus-Agent 아키텍처 설계서](https://claude.ai/code/artifact/f6653a04-00d1-4811-ba1d-238f33badf16)에 있습니다.
이 문서는 1단계에서 실제로 만든 구조만 적습니다.

## 1단계 실행 흐름

1. Paperclip이 `nexus_dispatch` 에이전트의 하트비트를 깨우고 어댑터의 `execute()`를 부릅니다. 어댑터는 Paperclip 서버 프로세스 안에서 돌기 때문에 별도 Nexus 서버가 필요 없습니다.
2. 어댑터가 실행마다 받은 에이전트 토큰으로 이슈를 읽습니다 (`GET /api/issues/:id`).
3. 분류기(`packages/core/src/classifier.ts`)가 실행 작업인지, 비코딩 작업인지, 작업 종류와 위험도를 판정합니다.
4. 비코딩 작업이고 `nonCodingAgentId`가 있으면 하위 이슈를 만들어 그 에이전트에게 배정하고 끝냅니다.
5. 실행 작업이면 라우터(`packages/core/src/router.ts`)가 `routing.yaml`에서 별칭 순서를 만들고, `models.yaml`에서 엔진과 모델을 찾습니다.
6. 엔진별 실행기가 작업 폴더에서 실행합니다.
   - Claude Code: `claude -p --output-format json --model <모델> --dangerously-skip-permissions`, 지시문은 표준 입력, `ANTHROPIC_API_KEY`는 지워 구독 계정으로 실행
   - OpenCode: 빈 포트에 `opencode serve`를 비밀번호와 함께 띄우고, 세션을 만든 뒤 `POST /session/:id/message`에 모델을 지정해 보냄. 끝나면 `GET /session/:id/diff`로 바뀐 파일을 가져오고 서버를 종료
7. 공급자 문제(한도, 로그인, 연결)면 다음 별칭으로 넘어가고, 작업 자체가 실패하면 멈춥니다.
8. 결과를 이슈 댓글로 남기고, 토큰·비용·모델을 Paperclip에 돌려줘 예산 집계에 반영합니다.

## 바뀐 설계 결정

- 1단계에는 `apps/nexus-server`가 없습니다. 외부 어댑터가 Paperclip 안에서 실행되므로 필요해지는 2단계(정책 편집 화면, 병렬 실행 관리)에 만듭니다.
- 어댑터는 `@paperclipai/adapter-utils`를 런타임에 불러오지 않습니다. 필요한 타입만 `adapter-types.ts`에 옮겼고, 빌드할 때 의존성을 모두 묶어 Paperclip이 패키지 설치 없이 불러올 수 있게 했습니다.
