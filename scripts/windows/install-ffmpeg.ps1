# 텔레그램 음성 메시지(OGG)를 Whisper가 읽는 WAV로 바꿀 ffmpeg.exe를 내려받는다.
# 음성 비서 화면의 'ffmpeg 설치' 버튼이 이 스크립트를 실행한다. 직접 실행해도 된다:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-ffmpeg.ps1
param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA "Nexus\whisper")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Save-Url([string]$Url, [string]$OutFile) {
  $part = "$OutFile.part"
  if (Test-Path $part) { Remove-Item -Force $part }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -L --fail -sS -o $part $Url
    if ($LASTEXITCODE -ne 0) { throw "내려받지 못했어요: $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
  }
  Move-Item -Force $part $OutFile
}

# 작은 순서대로: gyan.dev essentials(약 90MB), 안 되면 GitHub의 BtbN 빌드
$sources = @(
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
)

try {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $exe = Join-Path $Dest "ffmpeg.exe"
  if (Test-Path $exe) { Write-Output "ffmpeg는 이미 있어요."; exit 0 }

  $zip = Join-Path $env:TEMP "nexus-ffmpeg.zip"
  $tmp = Join-Path $env:TEMP "nexus-ffmpeg-unzip"
  $done = $false
  foreach ($url in $sources) {
    try {
      Write-Output "ffmpeg를 받는 중이에요: $url"
      Save-Url $url $zip
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $found = Get-ChildItem -Path $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
      if (-not $found) { throw "받은 파일에 ffmpeg.exe가 없어요." }
      Copy-Item -Force $found.FullName $exe
      $done = $true
      break
    } catch {
      Write-Output "실패해서 다른 곳에서 받아 볼게요: $($_.Exception.Message)"
    } finally {
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
      if (Test-Path $zip) { Remove-Item -Force $zip -ErrorAction SilentlyContinue }
    }
  }
  if (-not $done) { throw "ffmpeg를 받지 못했어요. 인터넷 연결을 확인해 주세요." }
  Write-Output "설치를 마쳤어요: $exe"
  exit 0
} catch {
  Write-Output "설치하지 못했어요: $($_.Exception.Message)"
  exit 1
}
