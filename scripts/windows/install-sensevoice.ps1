# Nexus 음성 비서의 빠른 엔진: sherpa-onnx와 SenseVoice 모델(한국어·영어·일본어·중국어)을 내려받는다.
# 음성 비서 화면의 'SenseVoice 설치' 버튼이 이 스크립트를 실행한다. 직접 실행해도 된다:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-sensevoice.ps1
param(
  [string]$Dest = (Join-Path $env:LOCALAPPDATA "Nexus\sensevoice")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Headers = @{ "User-Agent" = "nexus-agent" }
$Api = "https://api.github.com/repos/k2-fsa/sherpa-onnx"

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

# Windows 10 이상에 들어 있는 tar.exe로 .tar.bz2를 푼다.
function Expand-TarBz2([string]$File, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  & tar.exe -xjf $File -C $To
  if ($LASTEXITCODE -ne 0) { throw "압축을 풀지 못했어요: $File" }
}

try {
  New-Item -ItemType Directory -Force -Path $Dest, (Join-Path $Dest "models") | Out-Null
  $bin = Join-Path $Dest "bin"
  $exe = Join-Path $bin "sherpa-onnx-offline.exe"

  if (-not (Test-Path $exe)) {
    Write-Output "sherpa-onnx 최신 버전을 찾는 중이에요."
    $rel = Invoke-RestMethod -Uri "$Api/releases/latest" -Headers $Headers
    $win = @($rel.assets | Where-Object { $_.name -match "win-x64" -and $_.name -match "\.tar\.bz2$" -and $_.name -notmatch "cuda|gpu|jni|directml|debug" -and $_.name -cnotmatch "-MD" })
    $asset = ($win | Where-Object { $_.name -match "static" } | Select-Object -First 1)
    if (-not $asset) { $asset = $win | Select-Object -First 1 }
    if (-not $asset) { throw "Windows용 sherpa-onnx 파일을 찾지 못했어요 ($($rel.tag_name))." }

    Write-Output "sherpa-onnx $($rel.tag_name)을 받는 중이에요."
    $file = Join-Path $env:TEMP "nexus-sherpa.tar.bz2"
    $tmp = Join-Path $env:TEMP "nexus-sherpa-unpack"
    Save-Url $asset.browser_download_url $file
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-TarBz2 $file $tmp
    $found = Get-ChildItem -Path $tmp -Recurse -Filter "sherpa-onnx-offline.exe" | Select-Object -First 1
    if (-not $found) { throw "받은 파일에 sherpa-onnx-offline.exe가 없어요." }
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Copy-Item -Path (Join-Path $found.DirectoryName "*") -Destination $bin -Recurse -Force
    # 공유 빌드는 DLL이 lib 폴더에 있어서 실행 파일 옆으로 옮긴다.
    Get-ChildItem -Path $tmp -Recurse -Filter "*.dll" | ForEach-Object { Copy-Item -Force $_.FullName $bin }
    Remove-Item -Recurse -Force $tmp, $file
    Write-Output "sherpa-onnx를 설치했어요."
  } else {
    Write-Output "sherpa-onnx는 이미 있어요."
  }

  $have = Get-ChildItem -Path (Join-Path $Dest "models") -Recurse -Filter "tokens.txt" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $have) {
    Write-Output "SenseVoice 모델을 찾는 중이에요."
    $name = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
    try {
      $tag = Invoke-RestMethod -Uri "$Api/releases/tags/asr-models" -Headers $Headers
      $names = @()
      for ($page = 1; $page -le 20; $page++) {
        $list = @(Invoke-RestMethod -Uri "$Api/releases/$($tag.id)/assets?per_page=100&page=$page" -Headers $Headers)
        if (-not $list.Count) { break }
        $names += $list | ForEach-Object { $_.name }
      }
      $sv = @($names | Where-Object { $_ -match "^sherpa-onnx-sense-voice-zh-en-ja-ko-yue.*\.tar\.bz2$" } | Sort-Object -Descending)
      $pick = ($sv | Where-Object { $_ -match "int8" } | Select-Object -First 1)
      if (-not $pick) { $pick = $sv | Select-Object -First 1 }
      if ($pick) { $name = $pick }
    } catch {
      Write-Output "모델 목록을 읽지 못해 기본 모델을 받을게요."
    }
    Write-Output "SenseVoice 모델($name)을 받는 중이에요. 몇 분 걸려요."
    $file = Join-Path $env:TEMP "nexus-sensevoice.tar.bz2"
    Save-Url "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name" $file
    Expand-TarBz2 $file (Join-Path $Dest "models")
    Remove-Item -Force $file
    # 압축한 모델(int8)이 있으면 큰 원본 모델은 지운다.
    Get-ChildItem -Path (Join-Path $Dest "models") -Recurse -Filter "model.int8.onnx" | ForEach-Object {
      $full = Join-Path $_.DirectoryName "model.onnx"
      if (Test-Path $full) { Remove-Item -Force $full }
    }
  }
  Write-Output "설치를 마쳤어요. SenseVoice를 쓸 수 있어요."
  exit 0
} catch {
  Write-Output "설치하지 못했어요: $($_.Exception.Message)"
  exit 1
}
