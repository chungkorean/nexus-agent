@echo off
chcp 65001 >nul
rem Nexus 앱(스튜디오, 음성 비서)을 엽니다. 꺼져 있으면 Paperclip과 함께 켜요.
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0windows\nexus-tray.ps1" -OpenApp
