# Nexus-Agent

Paperclip이 지휘하고 OpenCode·Claude Code가 실행하는 하이브리드 에이전트 OS입니다.
Paperclip의 "개발 부서" 에이전트에 이슈가 배정되면, Nexus가 이슈를 읽고 분류해서
작업에 맞는 AI 모델로 자동 실행하고 결과를 이슈 댓글로 남깁니다.

설계 문서: [docs/architecture.md](docs/architecture.md)

## 되는 것

- **자동 호출**: Paperclip 외부 어댑터 `nexus_dispatch`가 하트비트마다 배정된 이슈를 처리합니다.
- **분류**: 코드 수정뿐 아니라 터미널 명령, 엑셀 파싱, APK 디컴파일 같은 로컬 작업도 "실행 작업"으로 봅니다. 라벨(`code`, `비코딩`)이 있으면 라벨이 우선합니다.
- **모델 선택**: `config/routing.yaml`의 작업 종류별 순서에 따라 엔진과 모델을 고릅니다. Claude 모델은 구독 계정으로 Claude Code에서, 그 밖의 모델은 OpenCode에서 실행합니다.
- **대체 실행**: 한도 초과나 로그인 만료 같은 공급자 문제면 다음 모델로 넘어갑니다.
- **비코딩 위임**: 기획·세계관·홍보 문구 같은 작업은 지정한 에이전트(예: Hermes)에게 하위 이슈로 넘깁니다.
- **결과 보고**: 요약, 바뀐 파일, 토큰·비용을 이슈 댓글로 남기고 Paperclip 비용 집계에 보고합니다.

- **작업 분해와 병렬 실행** (2단계): 큰 이슈는 AI가 하위 작업으로 나누고, Paperclip 하위 이슈로 보여 주며, 여러 모델과 계정에 동시에 맡깁니다. 각 결과는 `nexus/<이슈>/<작업>` 브랜치에 커밋으로 남습니다.
- **여러 계정**: 같은 서비스 계정을 여러 개 등록해 두고, 한도에 걸린 계정은 잠시 쉬게 한 뒤 다른 계정으로 넘어갑니다.
- **쉬운 설정 화면**: 작업별 담당 AI, 작업 나누기, 계정 로그인을 브라우저 화면에서 바꿉니다.

- **결과 취합** (3단계): 하위 작업이 모두 성공하면 브랜치를 `nexus/<이슈>/result`에 차례로 합칩니다. 충돌하면 AI가 한 번 풀고, 합친 결과로 프로젝트 테스트를 돌리고, 구현에 쓰지 않은 회사의 모델이 전체 변경을 검토합니다. 테스트가 통과하고 검토에서 문제가 없으면 작업 폴더의 현재 브랜치에 자동으로 합칩니다. 아니면 이유와 `git merge` 명령을 상위 이슈 댓글에 남깁니다. 모델별 사용량도 함께 보고합니다. 이 동작은 설정 화면의 "작업이 끝나면"에서 켜고 끕니다.
- **사용량과 예산** (4단계): 모델을 부를 때마다 계정, 모델, 토큰, 비용, 성공 여부를 기록하고 설정 화면의 "사용량"에서 기간별로 보여 줍니다. 계정마다 월 예산(달러)이나 월 토큰 한도를 정하면, 다 쓴 계정은 다음 달 1일까지 건너뛰고 같은 AI의 다음 계정이나 2순위 AI로 넘어갑니다. 기록을 보고 자주 실패하는 모델이 있으면 담당 AI를 바꿔 보라고 제안합니다.
- **트레이 실행기** (4단계): `scripts\nexus-tray.cmd`를 두 번 누르면 Paperclip과 설정 화면이 창 없이 켜지고, 작업 표시줄 오른쪽 아래에 N 아이콘이 생깁니다. 멈추면 다시 켜고, 메뉴에서 화면 열기, 다시 시작, Windows 시작 시 자동 실행, 종료를 고릅니다.
- **GitHub 연동** (선택, 기본 꺼짐): 켜면 결과 브랜치를 작업 폴더의 원격 저장소에 올리고, 원하면 GitHub CLI(`gh`)로 초안 풀 리퀘스트를 만듭니다. 작업 폴더의 git 로그인 정보와 `gh auth login`을 그대로 씁니다.

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

### 5. 설정 화면에서 바꾸기

`scripts\nexus-settings.cmd`를 두 번 누르거나 `pnpm settings`를 실행하면 브라우저에 설정 화면(http://127.0.0.1:3200)이 열립니다.

- **작업별 담당 AI**: 구현, 테스트, 리뷰 같은 작업마다 1순위와 2순위 AI를 고릅니다.
- **작업 나누기**: 큰 이슈만 나눌지, 항상 나눌지, 나누지 않을지와 동시에 몇 개까지 돌릴지 정합니다.
- **계정**: 계정을 추가하고 "로그인 창 열기"로 로그인합니다. 한도로 쉬는 계정과 쉬는 시각이 보입니다.
- **AI 모델**: 각 AI가 어떤 계정을 쓸지 고릅니다. 모델 이름은 "고급"에 있습니다.
- **계정의 월 예산**: 계정 칸의 "월 예산 정하기"에서 달러나 토큰 한도를 적습니다. 비우면 제한이 없습니다.
- **사용량**: 오늘, 최근 7일, 최근 30일, 이번 달의 실행 수, 성공률, 토큰, 비용을 계정별·AI 모델별로 봅니다.

저장하기 전에 "미리 보기"로 바뀌는 내용을 확인할 수 있고, 잘못 바꿨으면 "되돌리기"를 누르세요. 다음 작업부터 적용됩니다.

설정 파일은 `%LOCALAPPDATA%\Nexus\config`에 있습니다 (`models.yaml`, `routing.yaml`, `accounts.yaml`). 처음 화면을 열 때 기본 설정을 복사해 둡니다. 직접 고쳐도 되고, 주석에 설명이 있습니다. OpenCode 모델 이름은 `opencode models`로 확인한 값을 넣어야 합니다.

### 6. 트레이 실행기로 켜 두기

매번 PowerShell 창을 열어 두는 대신 `scripts\nexus-tray.cmd`를 두 번 누르세요.

- Paperclip(`npx paperclipai@latest run`)과 설정 화면이 창 없이 켜집니다. 이미 켜져 있으면 그대로 씁니다.
- 작업 표시줄 오른쪽 아래 N 아이콘: 파란색은 모두 켜짐, 갈색은 켜는 중, 빨간색은 계속 멈춤입니다.
- 아이콘을 두 번 누르면 Paperclip이 열리고, 오른쪽 버튼을 누르면 메뉴가 나옵니다.
- 멈추면 자동으로 다시 켭니다(10분에 3번까지). 기록은 `%LOCALAPPDATA%\Nexus\logs`에 남습니다.
- 메뉴의 "Windows를 켤 때 자동으로 실행"을 누르면 시작 프로그램에 등록됩니다.
- 끌 때는 메뉴의 "종료"를 누르세요. 함께 켠 Paperclip과 설정 화면도 꺼집니다.

### 7. 작업 나누기 라벨

- `분해` 또는 `plan`: 작은 이슈라도 나눠서 실행
- `단일` 또는 `no-plan`: 큰 이슈라도 한 번에 실행

작업 나누기를 쓰려면 작업 폴더가 커밋이 하나 이상 있는 git 저장소여야 합니다. 아니면 하위 작업을 같은 폴더에서 하나씩 실행합니다. 커밋하지 않은 변경은 하위 작업에 들어가지 않으니, 맡기기 전에 커밋해 두세요.

## 저장소 구조

```
packages/
  shared/                 공통 타입, 설정 읽기, 계정 상태, 프로세스 실행(Windows 대응), git·worktree
  core/                   분류기, 라우터, 작업 분해(플래너), 실행 지시문
  executor-opencode/      opencode serve를 띄워 작업마다 모델을 골라 실행
  executor-claude-code/   claude -p로 구독 계정 실행 (계정 분리는 CLAUDE_CONFIG_DIR)
  paperclip-client/       Paperclip 이슈 API
  paperclip-adapter/      Paperclip 외부 어댑터 nexus_dispatch (빌드 결과가 dist/)
apps/
  nexus-server/           쉬운 설정 화면 (127.0.0.1:3200)
config/                   기본 models.yaml, routing.yaml, accounts.yaml
scripts/                  어댑터 빌드, Windows 환경 점검
tests/                    가짜 Paperclip·OpenCode·Claude Code로 돌리는 테스트
```

## 아직 확인하지 못한 것

다음은 사용자 PC에서 0단계로 확인해야 합니다.

- Paperclip이 Windows에서 그대로 도는지 (안 되면 WSL2)
- 실제 Paperclip이 이 어댑터를 로컬 경로로 설치·실행하는지 (계약은 `@paperclipai/adapter-utils` 2026.1005.0 타입에 맞춤)
- 이슈 API의 라벨 응답 형식 (라벨 이름을 못 읽으면 키워드 분류만 동작)
- Windows에서 계정별 폴더 분리(`CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`)가 되는지
- 하위 이슈 상태 값(`in_progress`, `done`, `blocked`)을 Paperclip이 그대로 받는지 (안 받으면 상태만 안 바뀌고 댓글은 남음)
- Paperclip의 실행 시간 제한이 하위 작업 여러 개를 도는 동안 끊지 않는지
