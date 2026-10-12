# Nexus-Agent 인계 문서 (0.3.5 기준)

## 개요와 현재 상태

Nexus-Agent는 Paperclip의 에이전트 작업을 OpenCode, Claude Code, Antigravity(Google 계정 Gemini) 세 가지 엔진으로 나눠 보내고, 설정 화면(스튜디오, 음성 비서, 모델·계정·예산)을 함께 제공하는 Windows용 프로그램이며 현재 버전은 0.3.4입니다.

- 저장소: [chungkorean/nexus-agent](https://github.com/chungkorean/nexus-agent), 브랜치 `main`. 사용자 PC의 설치 위치는 `C:\nexus-agent`.
- 마지막 기능 커밋: `ec372ca` (0.3.4, 켜는 중 화면 개선). 0.3.5는 이 문서만 추가. 테스트 123개 통과.
- 엔진: `opencode`(provider/model 형식), `claude-code`(구독 계정), `antigravity`(`agy` 실행, Google 계정 하나만 가능). Meta Muse는 OpenCode provider `meta`로 연결.
- Paperclip 연결: 어댑터 `nexus_dispatch`를 켤 때 자동 설치하고, 빌드가 바뀌면 다시 불러옵니다.
- 사용자에게는 설치 프로그램 `NexusSetup.exe`(저장소 맨 위)와 바탕화면 `Nexus.exe`로 전달합니다.

## 저장소 구조와 실행 흐름

실행 흐름: Nexus.exe(Go 런처) → `scripts/windows/nexus-tray.ps1`(트레이) → Paperclip과 설정 서버 두 개를 숨은 창으로 실행 → Edge/Chrome 앱 모드 창.

| 위치 | 역할 |
| --- | --- |
| `packages/shared` | 타입, 설정(`config.ts`), 계정 상태(`state.ts`), 모델 목록(`catalog.ts`) |
| `packages/executor-*` | 엔진별 실행기. antigravity는 `agy -p ... --output-format json --model ...` |
| `packages/paperclip-adapter` | Paperclip 어댑터 `nexus_dispatch` (`scripts/build-adapter.mjs`로 빌드) |
| `apps/nexus-server` | 설정 서버와 화면(`public/index.html`, `common.js`, `base.css`), `adapter-sync.ts`, `extras.ts`(`/api/info`) |
| `apps/launcher` | Nexus.exe 런처(Go) |
| `apps/installer` | NexusSetup.exe(Go 실행기 + `setup.ps1` WinForms): Node.js·git 설치, clone, 빌드, 바로 가기 |
| `scripts/windows/nexus-tray.ps1` | 트레이, 켜는 중 화면, 자동 업데이트, 앱 창 지켜보기 |
| `scripts/paperclip-run.mjs` | Paperclip을 한 번 설치해 두고 바로 켜고, 새 버전은 뒤에서 받음 |
| `scripts/build-exe.mjs`, `build-settings.mjs` | exe 두 개 빌드, 설정 화면 묶음(`dist/public` 복사 + `build.json`) |

데이터는 `%LOCALAPPDATA%\Nexus`(계정, 설정, `state/telegram.json`, `logs/`, `paperclip/<버전>`)에 있고 저장소에는 올라가지 않습니다.

## 작업 규칙과 검증 방법

규칙

1. `main`에 바로 푸시합니다. PR을 만들지 않습니다.
2. 푸시할 때마다 `package.json`의 `version`을 올립니다. 자동 업데이트는 버전이 올라갔을 때만 받습니다.
3. 텔레그램 봇 토큰은 사용자 PC의 `state/telegram.json`에만 두고 설정 API가 돌려주지 않습니다.
4. 사용자에게는 한국어로 답합니다.
5. 커밋 끝에 Co-Authored-By와 Claude-Session 줄을 붙입니다.
6. PowerShell 파일은 UTF-8 BOM + CRLF로 저장합니다(아니면 5.1에서 한글이 깨집니다). Python으로 앞 3바이트(BOM)를 빼고 디코드해 `\r\n`을 `\n`으로 바꾸고 고친 뒤 BOM과 CRLF를 다시 붙이는 방식을 썼습니다.

검증

- `pnpm -s test`(123개), `npx tsc --noEmit -p .`, `pnpm -s build`, `pnpm -s build:exe`(Nexus.exe와 NexusSetup.exe).
- PowerShell 문법 검사: pwsh 7으로 파싱(`Parser::ParseFile`). Linux에서는 WinForms·System.Drawing을 돌릴 수 없어 트레이·켜는 중 화면은 실제 Windows에서 확인하지 못했습니다.
- 화면 확인: Playwright + chromium(`/opt/pw-browsers`)로 임시 테스트에서 스크린샷을 찍고 지웁니다.
- 푸시가 가끔 `remote rejected`로 실패하며, 잠시 뒤 다시 푸시하면 됩니다.

## 이번 작업에서 한 일

| 버전 / 커밋 | 내용 |
| --- | --- |
| 86b1a8d | Google 계정 Gemini(Antigravity CLI `agy`)와 Meta Muse 추가 |
| e09f800 · 12748cc | 위쪽 메뉴 고정, 모델 고르기 창 떨림 수정, Gemini 계정 체크칸, '무료' 표시 설명 |
| 09d797d | Paperclip 어댑터 자동 설치 |
| 0.2.0 (0acf26d) | 버전 관리와 버전이 올라갔을 때만 받는 자동 업데이트, 다른 사람과 쓰는 방법 |
| 0.3.0 (aa43fd2) | X는 완전 종료, _는 트레이로; 설치 프로그램 NexusSetup.exe |
| 0.3.1 · 0.3.2 | 켜는 중 화면, 설치 프로그램이 보이지 않던 문제(SW_HIDE)와 NexusSetup.exe 잠김 해결 |
| 0.3.3 (8bc5fc8) | X 종료가 들쭉날쭉하던 문제, 느린 켜기(Paperclip 로컬 설치), Zen 카드 계정 목록 수정, `app-windows.log` 기록 |
| 0.3.4 (ec372ca) | 켜는 중 화면을 끌어서 옮기고 다른 창 뒤로 보낼 수 있게, 코드로 그린 로딩 애니메이션(파란 점 10개가 돌고 가운데 N이 숨 쉬듯 커졌다 작아짐) |

0.3.4의 켜는 중 화면은 `Show-Splash`에서 만듭니다. 테두리 없는 창이라 마우스로 직접 끌기를 처리하고(화면 좌표 기준), `TopMost`를 꺼서 다른 창이 위로 올라올 수 있습니다. 애니메이션은 33ms 타이머가 패널을 다시 그리며, 회전 속도는 `Stopwatch` 시간 기준이라 화면이 바빠도 일정합니다.

## Windows 함정과 알려진 문제, 다음 할 일

함정(이미 한 번씩 당했던 것)

- Go에서 `SysProcAttr.HideWindow`를 쓰면 SW_HIDE로 PowerShell의 첫 창이 숨겨진 채 프로세스가 남아 `NexusSetup.exe`가 잠깁니다. `CreationFlags: createNoWindow`만 씁니다.
- PowerShell 5.1에서 `$ErrorActionPreference = "Stop"`일 때 외부 명령(taskkill, git)의 오류 출력이 예외가 됩니다. 종료·정리 코드는 `Continue`로 바꾸고 try/catch로 감쌉니다.
- `Start-Process -PassThru`로 종료 코드를 읽으려면 `$null = $p.Handle`이 필요합니다.
- git pull 도중 끊기면 `.git\index.lock`이 남습니다(`Remove-Item C:\nexus-agent\.git\index.lock -Force` 후 `git reset --hard`, `git pull`).
- 설정 화면 포트를 예전 서버가 잡고 있으면 새 코드가 안 보입니다. 트레이가 `/api/info`의 build가 `git rev-parse HEAD`와 다른지 보고 끕니다.
- `agy`는 로그인을 OS 키링에 저장해 Google 계정을 하나만 씁니다. 로그인 여부는 계정 폴더의 `.nexus-login` 파일로 짐작합니다.

아직 확인하지 못한 것

- 트레이 스크립트의 변경(0.3.3 종료 수정, 0.3.4 켜는 중 화면)은 문법 검사만 했고 실제 Windows에서는 돌리지 못했습니다. 0.3.3에 대한 사용자의 확인 결과는 "다 잘 되고 있다"였습니다.
- X 종료가 다시 들쭉날쭉해지면 `%LOCALAPPDATA%\Nexus\logs\app-windows.log`에 남는 줄(보이는 창 수와 제목, 숨긴 창 수, 브라우저 프로세스 수)로 원인을 찾습니다.
- Paperclip 업데이트 뒤 첫 실행은 새로 설치하느라 몇 분 걸립니다(켜는 중 화면에 "Paperclip을 처음 설치하는 중"이라고 뜨는 것이 정상).

다음에 해 볼 만한 일

- Paperclip 버전을 고정(pin)할지 정하기. 지금은 정식 최신 버전(`latest` 태그)을 따라갑니다.
- Windows에서 켜기·종료·업데이트·설치 프로그램을 한 번 전체로 돌려 보는 절차서(현재는 사용자의 수동 확인에 의존).
