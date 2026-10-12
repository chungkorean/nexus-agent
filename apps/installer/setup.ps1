# Nexus 설치 프로그램 (NexusSetup.exe 안에 들어 있는 스크립트, Windows PowerShell 5.1)
# 설치할 폴더를 고르고 "설치하기"를 누르면:
#   1) Node.js(24 LTS)와 git이 없으면 설치한다 (winget, 없으면 공식 설치 파일을 받아서)
#   2) GitHub에서 Nexus를 받는다 (git clone, 이미 있으면 git pull)
#   3) 패키지를 설치하고 빌드한다 (pnpm install, pnpm build)
#   4) 바탕 화면에 Nexus 바로 가기를 만든다
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = "https://github.com/chungkorean/nexus-agent"
$NodeMin = [version]"24.11.0"
$Font = New-Object System.Drawing.Font("Malgun Gothic", 10)

# ---------- 화면 ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = "Nexus 설치"
$form.Size = New-Object System.Drawing.Size(620, 520)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = $Font

$title = New-Object System.Windows.Forms.Label
$title.Text = "Nexus를 설치할 폴더를 골라 주세요."
$title.Font = New-Object System.Drawing.Font("Malgun Gothic", 13, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(20, 18)
$title.AutoSize = $true
$form.Controls.Add($title)

$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Text = Join-Path $env:USERPROFILE "Nexus"
$pathBox.Location = New-Object System.Drawing.Point(22, 60)
$pathBox.Size = New-Object System.Drawing.Size(450, 28)
$form.Controls.Add($pathBox)

$browse = New-Object System.Windows.Forms.Button
$browse.Text = "찾아보기..."
$browse.Location = New-Object System.Drawing.Point(480, 58)
$browse.Size = New-Object System.Drawing.Size(100, 30)
$browse.add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "Nexus를 설치할 폴더"
  $dlg.SelectedPath = $pathBox.Text
  if ($dlg.ShowDialog() -eq "OK") { $pathBox.Text = $dlg.SelectedPath }
})
$form.Controls.Add($browse)

$note = New-Object System.Windows.Forms.Label
$note.Text = "이 폴더 안에 nexus-agent 폴더가 생겨요. Node.js와 git이 없으면 함께 설치해요.`r`n설치 중에 Windows가 '변경을 허용할까요?'라고 물으면 '예'를 눌러 주세요."
$note.Location = New-Object System.Drawing.Point(22, 96)
$note.Size = New-Object System.Drawing.Size(560, 44)
$note.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($note)

$runAfter = New-Object System.Windows.Forms.CheckBox
$runAfter.Text = "설치가 끝나면 Nexus 실행하기"
$runAfter.Checked = $true
$runAfter.Location = New-Object System.Drawing.Point(22, 146)
$runAfter.AutoSize = $true
$form.Controls.Add($runAfter)

$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = "Vertical"
$log.Location = New-Object System.Drawing.Point(22, 180)
$log.Size = New-Object System.Drawing.Size(558, 210)
$log.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($log)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(22, 400)
$bar.Size = New-Object System.Drawing.Size(558, 14)
$bar.Maximum = 5
$form.Controls.Add($bar)

$install = New-Object System.Windows.Forms.Button
$install.Text = "설치하기"
$install.Location = New-Object System.Drawing.Point(370, 428)
$install.Size = New-Object System.Drawing.Size(105, 36)
$install.Font = New-Object System.Drawing.Font("Malgun Gothic", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($install)
$form.AcceptButton = $install

$close = New-Object System.Windows.Forms.Button
$close.Text = "닫기"
$close.Location = New-Object System.Drawing.Point(480, 428)
$close.Size = New-Object System.Drawing.Size(100, 36)
$close.add_Click({ $form.Close() })
$form.Controls.Add($close)

# ---------- 도우미 ----------
function Say([string]$text) {
  $log.AppendText($text + "`r`n")
  [System.Windows.Forms.Application]::DoEvents()
}
function Pump { [System.Windows.Forms.Application]::DoEvents() }

# 프로그램을 실행하고 끝날 때까지 화면을 살려 둔 채 기다린다. 종료 코드를 돌려준다.
# -Elevate: 관리자 권한을 요청할 수 있는 설치 파일(출력을 받지 않고 Windows가 허락 창을 띄우게 둔다)
function Run([string]$file, [string]$arguments, [string]$dir = $env:TEMP, [switch]$Elevate) {
  if ($Elevate) {
    $p = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $dir -PassThru
    while (-not $p.HasExited) { Pump; Start-Sleep -Milliseconds 150 }
    $p.WaitForExit()
    return $p.ExitCode
  }
  $out = Join-Path $env:TEMP ("nexus-setup-" + [guid]::NewGuid().ToString("N") + ".log")
  $p = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $dir -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  while (-not $p.HasExited) { Pump; Start-Sleep -Milliseconds 150 }
  $p.WaitForExit()
  foreach ($f in @($out, "$out.err")) {
    if (Test-Path $f) {
      $tail = Get-Content $f -Tail 3 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }
      foreach ($line in $tail) { Say ("    " + $line) }
      Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
  }
  return $p.ExitCode
}

# 화면을 멈추지 않고 파일을 받는다.
function Download([string]$url, [string]$file) {
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add("User-Agent", "NexusSetup")
  $task = $wc.DownloadFileTaskAsync($url, $file)
  while (-not $task.IsCompleted) { Pump; Start-Sleep -Milliseconds 150 }
  if ($task.IsFaulted) { throw $task.Exception.InnerException }
}

# 설치 프로그램이 바꾼 PATH를 이 창에도 반영한다.
function Update-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Get-NodeVersion {
  try { return [version]((& node --version 2>$null) -replace "^v", "") } catch { return $null }
}
function Has-Winget { return [bool](Get-Command winget -ErrorAction SilentlyContinue) }
function Winget([string]$id) {
  return Run "winget" "install -e --id $id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity"
}

function Install-Node {
  $v = Get-NodeVersion
  if ($v -and $v -ge $NodeMin) { Say "  Node.js $v 이 이미 있어요."; return }
  Say $(if ($v) { "  Node.js $v 은 오래돼서 새 버전으로 설치할게요..." } else { "  Node.js를 설치하는 중이에요..." })
  if (Has-Winget) { Winget "OpenJS.NodeJS.LTS" | Out-Null; Update-Path }
  if (-not ((Get-NodeVersion) -ge $NodeMin)) {
    Say "  Node.js 공식 설치 파일을 받는 중이에요..."
    $sums = (New-Object System.Net.WebClient).DownloadString("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt")
    $name = ([regex]::Match($sums, "node-v[\d.]+-x64\.msi")).Value
    if (-not $name) { throw "Node.js 설치 파일을 찾지 못했어요." }
    $msi = Join-Path $env:TEMP $name
    Download "https://nodejs.org/dist/latest-v24.x/$name" $msi
    Run "msiexec.exe" "/i `"$msi`" /passive /norestart" -Elevate | Out-Null
    Update-Path
  }
  $v = Get-NodeVersion
  if (-not ($v -ge $NodeMin)) { throw "Node.js를 설치하지 못했어요. https://nodejs.org 에서 직접 설치한 뒤 다시 시도해 주세요." }
  Say "  Node.js $v 설치 완료."
}

function Install-Git {
  if (Get-Command git -ErrorAction SilentlyContinue) { Say "  git이 이미 있어요."; return }
  Say "  git을 설치하는 중이에요..."
  if (Has-Winget) { Winget "Git.Git" | Out-Null; Update-Path }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Say "  git 공식 설치 파일을 받는 중이에요..."
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "NexusSetup")
    $rel = $wc.DownloadString("https://api.github.com/repos/git-for-windows/git/releases/latest") | ConvertFrom-Json
    $asset = $rel.assets | Where-Object { $_.name -match "^Git-[\d.]+-64-bit\.exe$" } | Select-Object -First 1
    if (-not $asset) { throw "git 설치 파일을 찾지 못했어요." }
    $exe = Join-Path $env:TEMP $asset.name
    Download $asset.browser_download_url $exe
    Run $exe "/VERYSILENT /NORESTART /NOCANCEL /SP-" -Elevate | Out-Null
    Update-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $env:Path += ";$env:ProgramFiles\Git\cmd" }
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git을 설치하지 못했어요. https://git-scm.com 에서 직접 설치한 뒤 다시 시도해 주세요." }
  & git config --global core.longpaths true 2>$null
  Say "  git 설치 완료."
}

function Get-Nexus([string]$repo) {
  if (Test-Path (Join-Path $repo ".git")) {
    Say "  이미 받아 둔 Nexus가 있어서 새 버전으로 바꿀게요..."
    if ((Run "git" "-C `"$repo`" pull --ff-only") -ne 0) { throw "Nexus를 새 버전으로 바꾸지 못했어요." }
    return
  }
  if ((Test-Path $repo) -and (Get-ChildItem $repo -Force | Select-Object -First 1)) { throw "$repo 폴더가 비어 있지 않아요. 다른 폴더를 골라 주세요." }
  Say "  GitHub에서 Nexus를 받는 중이에요... (로그인 창이 뜨면 GitHub에 로그인해 주세요)"
  if ((Run "git" "clone $RepoUrl `"$repo`"") -ne 0) { throw "Nexus를 받지 못했어요. 인터넷 연결과 GitHub 접근 권한을 확인해 주세요." }
}

function Build-Nexus([string]$repo) {
  Say "  필요한 패키지를 설치하는 중이에요... (몇 분 걸려요)"
  if ((Run "cmd.exe" "/d /c npx --yes pnpm@10 install" $repo) -ne 0) { throw "패키지를 설치하지 못했어요." }
  Say "  Nexus를 빌드하는 중이에요..."
  if ((Run "cmd.exe" "/d /c npx --yes pnpm@10 build" $repo) -ne 0) { throw "Nexus를 빌드하지 못했어요." }
}

function New-DesktopShortcut([string]$repo) {
  $exe = Join-Path $repo "Nexus.exe"
  $link = Join-Path ([Environment]::GetFolderPath("Desktop")) "Nexus.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($link)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $repo
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = "Nexus: Paperclip과 Nexus 앱을 켭니다"
  $lnk.Save()
  Say "  바탕 화면에 Nexus 바로 가기를 만들었어요."
}

# ---------- 설치 ----------
$install.add_Click({
  $base = $pathBox.Text.Trim()
  if (-not $base) { [System.Windows.Forms.MessageBox]::Show("설치할 폴더를 골라 주세요.", "Nexus 설치") | Out-Null; return }
  $repo = Join-Path $base "nexus-agent"
  $install.Enabled = $false; $browse.Enabled = $false; $pathBox.Enabled = $false; $close.Enabled = $false
  $log.Clear()
  $bar.Value = 0
  try {
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    Say "1/5 Node.js 확인"; Install-Node; $bar.Value = 1
    Say "2/5 git 확인"; Install-Git; $bar.Value = 2
    Say "3/5 Nexus 받기"; Get-Nexus $repo; $bar.Value = 3
    Say "4/5 Nexus 준비"; Build-Nexus $repo; $bar.Value = 4
    Say "5/5 바로 가기 만들기"; New-DesktopShortcut $repo; $bar.Value = 5
    Say ""
    Say "설치를 마쳤어요. 바탕 화면의 Nexus를 두 번 누르면 켜져요."
    $install.Text = "완료"
    if ($runAfter.Checked) { Start-Process -FilePath (Join-Path $repo "Nexus.exe") -WorkingDirectory $repo }
  } catch {
    Say ""
    Say ("설치하지 못했어요: " + $_.Exception.Message)
    Say "문제를 해결한 뒤 '설치하기'를 다시 누르면 이어서 설치해요."
    $install.Enabled = $true; $browse.Enabled = $true; $pathBox.Enabled = $true
  } finally {
    $close.Enabled = $true
  }
})

[void]$form.ShowDialog()
