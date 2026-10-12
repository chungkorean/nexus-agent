# Nexus 음성 비서용 Whisper(whisper.cpp)와 음성 모델을 내려받는다.
# 설정 화면의 'Whisper 설치' 버튼이 이 스크립트를 실행한다. 직접 실행해도 된다:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-whisper.ps1 -Model small-q5_1
param(
  [ValidateSet("base-q5_1", "small-q5_1", "large-v3-turbo-q5_0", "base", "small")]
  [string]$Model = "small-q5_1",
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

try {
  New-Item -ItemType Directory -Force -Path $Dest, (Join-Path $Dest "models") | Out-Null
  $exe = Join-Path $Dest "whisper-cli.exe"

  if (-not (Test-Path $exe)) {
    Write-Output "whisper.cpp 최신 버전을 찾는 중이에요."
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest" -Headers @{ "User-Agent" = "nexus-agent" }
    $asset = $rel.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } | Select-Object -First 1
    if (-not $asset) {
      $asset = $rel.assets | Where-Object { $_.name -match "bin-x64" -and $_.name -notmatch "cublas|cuda|blas|openvino|vulkan" } | Select-Object -First 1
    }
    if (-not $asset) { throw "Windows용 whisper.cpp 파일을 찾지 못했어요 ($($rel.tag_name))." }

    Write-Output "whisper.cpp $($rel.tag_name)을 받는 중이에요."
    $zip = Join-Path $env:TEMP "nexus-whisper.zip"
    $tmp = Join-Path $env:TEMP "nexus-whisper-unzip"
    Save-Url $asset.browser_download_url $zip
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $cli = Get-ChildItem -Path $tmp -Recurse -Filter "whisper-cli.exe" | Select-Object -First 1
    if (-not $cli) { throw "받은 파일에 whisper-cli.exe가 없어요." }
    Copy-Item -Path (Join-Path $cli.DirectoryName "*") -Destination $Dest -Recurse -Force
    Remove-Item -Recurse -Force $tmp, $zip
    Write-Output "whisper.cpp를 설치했어요."
  } else {
    Write-Output "whisper.cpp는 이미 있어요."
  }

  $modelFile = Join-Path $Dest "models\ggml-$Model.bin"
  if (-not (Test-Path $modelFile)) {
    Write-Output "음성 모델($Model)을 받는 중이에요. 크기에 따라 몇 분 걸려요."
    Save-Url "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" $modelFile
  }
  Write-Output "설치를 마쳤어요. 모델: ggml-$Model.bin"
  exit 0
} catch {
  Write-Output "설치하지 못했어요: $($_.Exception.Message)"
  exit 1
}
