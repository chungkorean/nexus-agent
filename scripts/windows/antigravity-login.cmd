@echo off
rem Nexus: Google account (Antigravity CLI) login window.
rem Installs agy with Google's official installer when missing, then runs agy,
rem which opens Google sign-in in the browser on first run.
rem Keep these comments ASCII: cmd reads them before chcp 65001.
chcp 65001 >nul
set "PATH=%PATH%;%LOCALAPPDATA%\agy\bin"
where agy >nul 2>nul
if errorlevel 1 (
  echo Antigravity CLI가 없어서 Google 공식 설치 프로그램으로 설치할게요...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"
  where agy >nul 2>nul
  if errorlevel 1 (
    echo.
    echo 설치하지 못했어요. https://antigravity.google/docs/cli/install 의 안내대로 직접 설치해 주세요.
    goto :eof
  )
)
echo.
echo 브라우저가 열리면 Gemini를 구독한 Google 계정으로 로그인해 주세요.
echo 로그인이 끝나고 입력 칸이 보이면 이 창을 닫아도 돼요.
echo.
agy
