@echo off
chcp 65001 >nul
rem Nexus 쉬운 설정 화면을 엽니다. 이 파일을 두 번 클릭하세요.
cd /d "%~dp0.."
echo Nexus 설정 화면을 준비하고 있어요. 잠시만 기다려 주세요...
call pnpm settings
if errorlevel 1 (
  echo.
  echo 설정 화면을 열지 못했어요. 위에 나온 내용을 확인해 주세요.
  echo pnpm이 없다는 말이 나오면 Node.js와 pnpm을 먼저 설치해 주세요.
  pause
)
