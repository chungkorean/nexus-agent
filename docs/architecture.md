# 아키텍처

전체 설계는 [Nexus-Agent 아키텍처 설계서](https://claude.ai/code/artifact/f6653a04-00d1-4811-ba1d-238f33badf16)에 있습니다.
이 문서는 실제로 만든 구조만 적습니다.

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

## 2단계: 작업 분해, 병렬 실행, 계정

분류 다음에 "나눌지"를 정합니다 (`packages/core/src/planner.ts`의 `shouldPlan`).

- `routing.yaml`의 `planning.mode`가 `always`면 항상, `never`면 나누지 않습니다.
- `auto`(기본)면 설명에 할 일 목록이 3개 이상이거나 600자를 넘을 때만 나눕니다. 라벨 `분해`/`plan`은 나누기, `단일`/`no-plan`은 나누지 않기를 강제합니다.

나누기로 하면 다음 순서로 실행합니다.

1. **계획**: `planning.planner` 별칭(기본 smart)을 **읽기 전용**으로 실행해 JSON 계획을 받습니다.
   - Claude Code: `--dangerously-skip-permissions` 없이 `--disallowedTools Edit Write MultiEdit NotebookEdit Bash`
   - OpenCode: `agent: "plan"`, 권한 설정에서 edit·bash 거부
   - 계획을 읽지 못하거나 하위 작업이 1개면 1단계처럼 한 번에 실행합니다.
2. **검사**: `parsePlan`이 키를 다듬고, 없는 의존을 지우고, 순환이면 거절합니다. 같은 파일·폴더를 건드리는 작업은 뒤 작업이 앞 작업을 기다리게 바꿉니다 (`addOverlapDependencies`).
3. **하위 이슈**: 하위 작업마다 Paperclip 하위 이슈를 만듭니다 (`parentId`, 담당자 없음, `todo`). 실행하며 `in_progress` → `done`/`blocked`로 바꾸고 결과를 그 이슈에 댓글로 남깁니다.
4. **병렬 실행**: `runSchedule`이 의존 순서를 지키며 `planning.concurrency`개씩 동시에 돌립니다.
   - 하위 작업마다 `git worktree`(`%LOCALAPPDATA%\Nexus\wt\<이슈>-<실행>\<키>`)를 마지막 커밋에서 만들고, 앞 작업 브랜치를 merge한 뒤 실행합니다.
   - 끝나면 모든 변경을 `nexus/<이슈>/<키>` 브랜치에 커밋하고 worktree 폴더는 지웁니다. 사용자의 작업 폴더는 건드리지 않습니다.
   - 앞 작업이 실패하면 기다리던 작업은 건너뜁니다.
   - 작업 폴더가 git 저장소가 아니거나 커밋이 없으면 같은 폴더에서 하나씩 실행합니다.
5. **취합** (3단계, `server/aggregate.ts`): 하위 작업이 모두 성공했을 때만 합니다. 설정은 `routing.yaml`의 `results`이고 설정 화면에서 바꿉니다.
   - **차례로 합치기**: 마지막 커밋에서 `nexus/<이슈>/result` worktree를 만들고, 의존 순서대로 하위 작업 브랜치를 `--no-ff`로 합칩니다.
   - **충돌 해결** (`resolveConflicts`): 충돌하면 충돌 상태를 둔 채 `highRiskAlias`부터 시작하는 순서로 AI에게 한 번 풀게 합니다. 충돌 표시가 남거나 실행이 실패하면 합치기를 되돌리고 실패로 보고합니다.
   - **테스트** (`runTests`, `testCommand`): 명령이 비어 있으면 `package.json`의 test 스크립트(pnpm/yarn/npm)나 pytest 설정·`test_*.py`를 보고 고릅니다. worktree에는 원래 폴더의 `node_modules`를 링크로 붙입니다(Windows는 junction). 테스트 도구가 없으면(명령 없음, `No module named pytest`) 실패로 보지 않습니다.
   - **교차 검토** (`review`): `review` 순서의 별칭 중 구현에 성공한 모델과 공급사가 다른 모델을 골라 전체 diff(최대 6만 자)를 읽기 전용으로 검토하게 합니다. 다른 공급사가 없으면 같은 공급사 모델로 검토했다고 밝힙니다. 답의 첫 줄 `판정: 문제 없음|확인 필요`를 읽습니다.
   - **작업 폴더 반영** (`autoMerge`): 테스트 실패, 검토 `확인 필요`, 위험도 높음 중 하나라도 있으면 합치지 않습니다. 합칠 때도 작업 폴더에 커밋하지 않은 변경이 있거나 브랜치가 없는 상태면 건드리지 않습니다.
   - **한 번에 실행할 때**: 작업 폴더가 git 저장소이고 바뀐 파일이 있으면 같은 `runTests`, `review` 설정으로 작업 폴더에서 바로 테스트하고 검토받습니다(새 파일은 내용을 통째로 diff에 붙임). 테스트가 실패하면 결과는 `확인 필요`, 이슈는 `blocked`입니다.
   - **저절로 생기는 파일**: `__pycache__`, `*.pyc`, `.pytest_cache` 등은 바뀐 파일 목록과 하위 작업 커밋에서 뺍니다.
   - **GitHub** (`githubPush`, `githubPullRequest`, `githubRemote`, 기본 꺼짐): 합치기가 성공하면 결과 브랜치를 원격에 `git push -u`하고, 켜져 있으면 `gh pr create --draft`로 작업 폴더의 현재 브랜치를 향한 초안 풀 리퀘스트를 만듭니다. 본문은 결과 댓글과 같습니다. 실패해도 실행 결과는 바꾸지 않고 이유만 댓글에 남깁니다. 환경 점검이 원격 저장소와 `gh auth status`를 확인합니다.
   - **보고**: 상위 이슈에 하위 작업 표, 결과 브랜치, 충돌 해결, 테스트, 검토 의견, 작업 폴더 반영 여부, 모델별 사용량을 한 댓글로 남깁니다. 합치기나 테스트가 실패하면 결과는 `확인 필요`, 이슈는 `blocked`가 됩니다.

### 계정

- `accounts.yaml`에 계정을 적고, `models.yaml`의 별칭에 `accounts: [..]`로 연결합니다. 계정 폴더는 Claude Code에 `CLAUDE_CONFIG_DIR`, OpenCode에 `XDG_DATA_HOME`으로 넘깁니다.
- 라우터는 별칭 순서를 계정까지 펼칩니다. 같은 별칭의 다른 계정으로 넘어가는 것은 `maxFallbacks`에 세지 않습니다.
- 병렬 하위 작업은 `spread`(하위 작업 번호)로 시작 계정을 돌려, 같은 모델이라도 계정이 나뉘게 합니다.
- 한도·로그인·연결 오류가 나면 그 계정을 쉬게 합니다 (한도 60분, 로그인 12시간, 연결 5분). 상태는 `%LOCALAPPDATA%\Nexus\state\accounts-state.json`에 남아 다음 실행과 설정 화면이 같이 봅니다.

### 쉬운 설정 화면

`apps/nexus-server`가 `127.0.0.1:3200`에 설정 화면을 띄웁니다 (`pnpm settings` 또는 `scripts\nexus-settings.cmd`). YAML의 주석을 지키며 고치고, 저장 전에 검사하며, 저장할 때마다 백업해 되돌릴 수 있습니다. 계정 추가와 로그인 창 열기도 여기서 합니다. 어댑터는 실행마다 설정 파일을 다시 읽으므로 서버를 켜 둘 필요는 없습니다.

## 4단계: 운영

### 사용량 기록

- 모든 모델 호출은 `runRoutes`를 지나고, 호출마다 `%LOCALAPPDATA%\Nexus\state\usage.jsonl`에 한 줄을 남깁니다: 시각, 이슈, 목적(작업 종류 또는 plan·review·conflict), 별칭, 엔진, 모델, 계정, 성공 여부, 오류 종류, 토큰, 비용, 걸린 시간.
- 설정 화면 `GET /api/usage?period=today|7d|30d|month`가 이 파일을 계정별·모델별로 합칩니다. 파일이 20MB를 넘으면 최근 부분만 읽습니다.

### 월 예산

- `accounts.yaml`의 계정에 `monthlyBudgetUsd`(달러)나 `monthlyTokenLimit`(입력+출력 토큰)을 적습니다. 설정 화면의 계정 칸에서 바꿉니다.
- 실행을 시작할 때 `AccountState.setBudgets`가 이번 달(현지 시각 1일부터) 기록을 읽어 계정별 사용량을 계산하고, 실행 중에는 호출마다 더합니다.
- 라우터는 쉬는 계정과 함께 예산을 넘은 계정도 뺍니다(`isUnavailable`). 그래서 같은 별칭의 다음 계정, 그다음 별칭(2순위 AI) 순으로 내려갑니다. 예산을 넘은 계정은 실행 로그에 이유를 남깁니다.
- Claude 구독은 Claude Code가 알려 주는 환산 비용이 기록되므로, 구독 계정에는 토큰 한도가 더 알맞습니다.

### 기록으로 본 제안

- 같은 목적에서 어떤 별칭이 5번 이상 실행해 성공률이 60% 미만이고, 다른 별칭이 3번 이상 실행해 80% 이상이면 설정 화면에 "1순위를 바꿔 보세요"라는 제안을 보여 줍니다. 설정을 자동으로 바꾸지는 않습니다.
- 한도·로그인·연결 오류는 모델 실력과 무관하므로 성공률 계산에서 뺍니다.

### 모델 목록

- 설정 화면 `GET /api/models`가 고를 수 있는 모델을 돌려줍니다(`packages/shared/src/catalog.ts`). Claude Code는 목록 명령이 없어서 `CLAUDE_MODELS`에 직접 두고, OpenCode는 평소 로그인과 OpenCode 계정 폴더(`XDG_DATA_HOME`)마다 `opencode models --verbose`를 돌려 이름·문맥 길이·비용을 읽습니다. 사라질 예정(deprecated)인 모델은 뺍니다.
- 결과는 `state/models-cache.json`에 캐시하고, `?refresh=1`이면 다시 읽습니다. 동시에 여러 번 요청해도 한 번만 돌립니다.
- 화면에서 목록의 모델을 고르면 `models.yaml`에 별칭을 만듭니다(`newAliases`). 엔진은 ID에 `/`가 있으면 OpenCode, 없으면 Claude Code입니다. 별칭을 지우면(`removeAliases`) 작업 순서에서도 빼고, 어떤 작업의 순서가 비거나 위험 작업·작업 나누기 담당이면 저장을 막습니다.

### 트레이 실행기

- `scripts\windows\nexus-tray.ps1`(PowerShell 5.1, 추가 설치 없음)이 `npx --yes paperclipai@latest run`과 설정 서버를 숨은 창으로 띄우고 `NotifyIcon`으로 관리합니다. `scripts\nexus-tray.cmd`가 이를 숨은 창으로 실행합니다.
- 포트(3100, 3200)가 이미 열려 있으면 띄우지 않습니다. 5초마다 포트를 확인해, 직접 띄운 프로세스가 끝났으면 10분에 3번까지 다시 띄웁니다.
- 끌 때는 직접 띄운 프로세스만 `taskkill /T`로 끕니다. 시작 프로그램 등록은 Startup 폴더의 바로 가기로 합니다.

### 텔레그램

- Paperclip에도 텔레그램 연결이 있지만 웹훅이라 공개 주소가 필요합니다. 집 PC에서 바로 쓰도록 Nexus 설정 서버 안에서 `getUpdates` 긴 폴링으로 받는 봇을 돌립니다(`apps/nexus-server/src/telegram-bot.ts`). 토큰을 저장할 때 웹훅이 있으면 지웁니다.
- 설정과 토큰은 `state/telegram.json`에 둡니다(설정 YAML 백업에 토큰이 들어가지 않게). 설정 화면에는 토큰을 돌려주지 않습니다.
- 연결: 설정 화면이 10분짜리 6자리 코드를 만들고, 1:1 대화방에서 그 코드를 보내면 그 대화방을 등록합니다. 틀린 코드를 5번 보내면 코드를 없앱니다. 등록한 대화방의 메시지만 처리합니다.
- 받은 글은 로컬 모드 Paperclip API(`POST /api/companies/:id/issues`, 토큰 없음)로 고른 에이전트에게 `todo` 이슈로 만듭니다. 등록 안내나 결과 알림에 답장하면 `POST /api/issues/:id/comments`에 `reopen: true`로 댓글을 남겨 다시 깨웁니다. 보낸 메시지와 이슈의 짝은 `state/telegram-messages.json`에 최근 500개까지 둡니다.
- 결과 알림은 어댑터가 결과 댓글을 남길 때(`postResult`) 같은 내용을 표를 뺀 짧은 글로 바꿔 보냅니다. 실패해도 실행 결과에는 영향이 없습니다.

## 5단계: 스튜디오, 음성 비서, 앱 창

### 작업 기록 보관함

- 어댑터가 결과 댓글을 남기는 `postResult`에서 `archiveRun`(`packages/shared/src/archive.ts`)을 불러 `state/archive/<YYYYMMDD-HHMMSS>-<이슈번호>/`에 `run.json`(이슈, 상태, 모델, 비용, 미디어 목록), `result.md`, `issue.md`, `media/`를 남깁니다. 임시 폴더에 쓴 뒤 이름을 바꿔 반쯤 쓴 기록이 보이지 않게 합니다. 실패해도 실행 결과에는 영향이 없습니다.
- 미디어 찾기: 한 번에 실행은 이번 실행에서 바뀐 파일(삭제 제외)을 작업 폴더에서 읽습니다. git status 경로는 저장소 맨 위 기준이라 작업 폴더에 없으면 저장소 맨 위에서 찾습니다. 작업 나누기는 결과 브랜치가 있으면 `git diff --name-only <시작 커밋>..<결과 브랜치>`로 찾아 `git show`로 꺼내고, 없으면 하위 작업 브랜치마다 같은 방법으로 찾습니다.
- 스튜디오 API: `GET /api/archive?q=&media=1`, `GET /api/archive/item?id=`, `GET /api/archive/media?id=&name=`(Range 지원, 기록에 있는 이름만), `POST /api/archive/continue`(이슈에 `reopen: true` 댓글), `/remove`, `/open`(Windows 탐색기). 미디어 응답에는 `sandbox` CSP를 붙여 AI가 만든 SVG를 새 탭에서 열어도 스크립트가 돌지 않게 합니다.

### 음성 비서

- 브라우저(`public/voice.html`)가 마이크 소리를 AudioWorklet으로 20ms씩 받아 소리 크기로 말의 시작과 끝을 찾고(주변 소음의 3배, 0.7초 조용하면 끝), 16kHz 모노 WAV로 바꿔 `POST /api/voice/transcribe`(`audio/wav`, `X-Nexus` 머리글, 20MB까지)로 보냅니다.
- 서버는 `whisper-cli -m <모델> -f <wav> -nt -np -l ko --prompt <호출어>`를 돌립니다(`apps/nexus-server/src/voice.ts`). 호출어를 prompt로 주면 호출어를 더 잘 알아듣습니다. Whisper가 조용한 소리에서 지어내는 말([음악], "시청해 주셔서 감사합니다" 등)은 버립니다. WAV가 아니면(텔레그램 OGG) ffmpeg로 먼저 바꿉니다.
- 호출어는 브라우저에서 확인합니다. 글로 바꾼 말의 앞부분을 공백·문장 부호를 빼고 호출어(기본 "넥서스"와 넥써스·nexus 같은 변형)와 비교하고, 한 글자 차이까지 받아 줍니다. 호출어가 아니면 흘려듣고, 알아듣거나 답을 읽는 동안에는 새 말을 받지 않습니다.
- 말 처리(`assistant.ts`)는 음성과 텔레그램이 함께 씁니다. 40자 이하의 말에서 도움말·사용량·진행 상황을 찾고, 나머지는 할 일로 보고 이슈를 만듭니다. 진행 상황은 Paperclip 이슈 목록에서 진행 중·할 일·막힘을 세고(하위 이슈 제외), 보관함에서 오늘 끝난 작업을 상태별로 셉니다.
- 설정은 `state/voice.json`(호출어, 언어, 소리로 읽기, 맡길 회사·에이전트, 직접 고른 경로)에 둡니다. Whisper는 `%LOCALAPPDATA%\Nexus\whisper`에서 찾고, 모델이 여럿이면 large-v3-turbo-q5_0, small, base 순으로 고릅니다.
- `scripts\windows\install-whisper.ps1`은 GitHub 최신 릴리스에서 `whisper-bin-x64.zip`을, Hugging Face `ggerganov/whisper.cpp`에서 `ggml-<모델>.bin`을 받습니다. 모델은 압축판(base-q5_1, small-q5_1, large-v3-turbo-q5_0)을 받습니다. `install-ffmpeg.ps1`은 gyan.dev essentials 빌드(안 되면 GitHub BtbN 빌드)에서 `ffmpeg.exe`만 꺼내 같은 폴더에 둡니다. 설치 버튼은 `ToolInstaller`가 이 스크립트들을 숨은 PowerShell로 하나씩 돌리고 출력 마지막 40줄을 보여 줍니다.

### 앱 창

- Tauri로 따로 빌드하는 대신, 트레이 실행기가 Edge(없으면 Chrome)를 `--app=http://127.0.0.1:3200/studio --user-data-dir=%LOCALAPPDATA%\Nexus\app-profile`로 띄웁니다. 추가 설치와 Rust 빌드 없이 주소창 없는 창과 작업 표시줄 아이콘이 생기고, 따로 쓰는 프로필이라 마이크 권한도 그 창에만 남습니다.
- `nexus-tray.ps1 -OpenApp`(바탕 화면 바로 가기, `scripts\nexus-app.cmd`)은 이미 켜져 있으면 창만 열고, 꺼져 있으면 모두 켠 뒤 창을 엽니다.
- 화면들은 `public/base.css`와 `public/common.js`(작은 도우미, 위쪽 메뉴)를 함께 씁니다.

## 바뀐 설계 결정

- `apps/nexus-server`는 사람이 보는 화면(설정, 스튜디오, 음성 비서)과 텔레그램 봇만 맡습니다. 병렬 실행 관리는 별도 서버 없이 어댑터 안에서 합니다. Paperclip이 에이전트당 실행을 하나씩 관리하므로 그 실행 안에서 하위 작업을 동시에 돌리는 편이 단순합니다.
- 하위 이슈는 담당자를 비워 둡니다. 개발 부서 에이전트에게 배정하면 Paperclip이 하위 이슈마다 하트비트를 깨워 같은 작업을 두 번 실행할 수 있습니다.
- 어댑터는 `@paperclipai/adapter-utils`를 런타임에 불러오지 않습니다. 필요한 타입만 `adapter-types.ts`에 옮겼고, 빌드할 때 의존성을 모두 묶어 Paperclip이 패키지 설치 없이 불러올 수 있게 했습니다.
