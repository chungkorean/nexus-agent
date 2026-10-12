@echo off
chcp 65001 >nul
rem Nexus 트레이 실행기를 켭니다. 이 파일을 두 번 누르세요.
rem Paperclip과 Nexus 설정 화면이 창 없이 켜지고, 작업 표시줄 오른쪽 아래에 N 아이콘이 생겨요.
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0windows\nexus-tray.ps1"
