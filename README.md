# Nexus-Agent

Paperclip이 지휘하고 OpenCode·Claude Code가 실행하는 하이브리드 에이전트 OS입니다.
Paperclip의 "개발 부서" 에이전트에 이슈가 배정되면, Nexus가 이슈를 읽고 분류해서
작업에 맞는 AI 모델로 자동 실행하고 결과를 이슈 댓글로 남깁니다.

설계 문서: [docs/architecture.md](docs/architecture.md)

## 1단계에서 되는 것

- **자동 호출**: Paperclip 외부 어댑터 `nexus_dispatch`가 하트비트마다 배정된 이슈를 처리합니다.
- **분류**: 코드 수정뿐 아니라 터미널 명령, 엑셀 파싱, APK 디컴파일 같은 로컬 작업도 "실행 작업"으로 봅니다. 라벨(`code`, `비코딩`)이 있으면 라벨이 우선합니다.
- **모델 선택**: `config/routing.yaml`의 작업 종류별 순서에 따라 엔진과 모델을 고릅니다. Claude 모델은 구독 계정으로 Claude Code에서, 그 밖의 모델은 OpenCode에서 실행합니다.
- **대체 실행**: 한도 초과나 로그인 만료 같은 공급자 문제면 다음 모델로 넘어갑니다.
- **비코딩 위임**: 기획·세계관·홍보 문구 같은 작업은 지정한 에이전트(예: Hermes)에게 하위 이슈로 넘깁니다.
- **결과 보고**: 요약, 바뀐 파일, 토큰·비용을 이슈 댓글로 남기고 Paperclip 비용 집계에 보고합니다.

작업 분해와 병렬 실행(2단계), 결과 병합(3단계)은 아직 없습니다.

## Windows에 설치하기

### 1. 필요한 프로그램

| 프로그램 | 설치 |
| --- | --- |
| Node.js 24.11 이상 | https://nodejs.org (Paperclip 요구 사항) |
| git | https://git-scm.com, 설치 후 `git config --global core.longpaths true` |
| pnpm | `npm install -g pnpm` |
| OpenCode | `npm install -g opencode-ai` 후 `opencode auth login`으로 공급자 로그인 |
| Claude Code | `npm install -g @anthropic-ai/claude-code` 후 `claude`를 실행해 구독 계정으로 로그인 |
| Paperclip | `npx paperclipai@latest onboard --yes` (화면: http://localhost:3100) |

설치가 끝나면 점검 스크립트를 돌려 보세요.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-env.ps1
```

### 2. 어댑터 빌드

```powershell
pnpm install
pnpm test
pnpm build
```

`packages\paperclip-adapter\dist`와 `packages\paperclip-adapter\config`가 만들어집니다.

### 3. Paperclip에 어댑터 설치

Paperclip 화면의 Adapter Manager에서 로컬 경로로 설치하거나, API로 설치합니다.

```powershell
$body = @{ packageName = "C:\경로\nexus-agent\packages\paperclip-adapter"; isLocalPath = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3100/api/adapters/install -ContentType "application/json" -Body $body
```

코드를 고친 뒤에는 `pnpm build` 후 Adapter Manager에서 다시 불러오기(reload)를 누릅니다.

### 4. 에이전트 만들기

1. **개발 부서**: 어댑터 `nexus_dispatch`로 에이전트를 만들고 설정에 다음을 넣습니다.

   ```json
   {
     "cwd": "C:\\work\\my-project",
     "nonCodingAgentId": "Hermes 에이전트 ID (선택)",
     "timeoutSec": 1800
   }
   ```

2. **비서(선택)**: 어댑터 `hermes_local`로 Hermes 에이전트를 만들고, 그 ID를 위 `nonCodingAgentId`에 넣습니다.
3. 에이전트 설정 화면의 환경 점검 버튼으로 작업 폴더, 설정 파일, `opencode`, `claude` 실행 여부를 확인합니다.

### 5. 모델 정책 바꾸기

기본 설정은 어댑터 패키지에 들어 있습니다. 고치려면 `config` 폴더를 `%LOCALAPPDATA%\Nexus\config`로 복사한 뒤 그 파일을 고치세요. 다음 실행부터 적용됩니다.

- `models.yaml`: 별칭(`smart`, `coder`, `fast`, `longctx`, `reviewer`, `local`)마다 엔진과 모델
- `routing.yaml`: 작업 종류별 별칭 순서, 로컬 모델 우선 여부, 대체 횟수

OpenCode 모델 이름은 `opencode models`로 확인한 값을 넣어야 합니다. 화면에서 고치는 설정 편집기는 2단계에서 만듭니다.

## 저장소 구조

```
packages/
  shared/                 공통 타입, 설정 읽기, 프로세스 실행(Windows 대응), git 비교
  core/                   분류기, 라우터, 실행 지시문
  executor-opencode/      opencode serve를 띄워 작업마다 모델을 골라 실행
  executor-claude-code/   claude -p로 구독 계정 실행 (계정 분리는 CLAUDE_CONFIG_DIR)
  paperclip-client/       Paperclip 이슈 API
  paperclip-adapter/      Paperclip 외부 어댑터 nexus_dispatch (빌드 결과가 dist/)
config/                   기본 models.yaml, routing.yaml
scripts/                  어댑터 빌드, Windows 환경 점검
tests/                    가짜 Paperclip·OpenCode·Claude Code로 돌리는 테스트
```

## 아직 확인하지 못한 것

다음은 사용자 PC에서 0단계로 확인해야 합니다.

- Paperclip이 Windows에서 그대로 도는지 (안 되면 WSL2)
- 실제 Paperclip이 이 어댑터를 로컬 경로로 설치·실행하는지 (계약은 `@paperclipai/adapter-utils` 2026.1005.0 타입에 맞춤)
- 이슈 API의 라벨 응답 형식 (라벨 이름을 못 읽으면 키워드 분류만 동작)
- Windows에서 계정별 폴더 분리(`CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`)가 되는지
