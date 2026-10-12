# Nexus 트레이 실행기 (Windows PowerShell 5.1 이상)
# Paperclip과 Nexus 설정 화면을 창 없이 켜 두고, 작업 표시줄 오른쪽 아래 아이콘으로 관리합니다.
# 보통은 scripts\nexus-tray.cmd 를 두 번 눌러 실행하세요.
param(
  [int]$PaperclipPort = 3100,
  [int]$SettingsPort = 3200,
  [switch]$NoPaperclip,
  # 바탕 화면 바로 가기용: Nexus 앱 창을 연다. 이미 켜져 있으면 창만 연다.
  [switch]$OpenApp
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$DataDir = if ($env:NEXUS_HOME) { $env:NEXUS_HOME } else { Join-Path $env:LOCALAPPDATA "Nexus" }
$AppUrl = "http://127.0.0.1:$SettingsPort/studio"

# Edge(없으면 Chrome)의 앱 모드로 Nexus 화면을 주소창 없는 창으로 연다.
# 따로 쓰는 프로필이라 마이크 권한도 이 창에만 한 번 허락하면 된다.
function Open-App([string]$url = $AppUrl) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $browser) { Start-Process $url; return }
  $appProfile = Join-Path $DataDir "app-profile"
  Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=`"$appProfile`"", "--window-size=1280,880", "--no-first-run", "--no-default-browser-check")
}

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# 지금 떠 있는 설정 화면이 이 저장소의 최신 코드인지 본다.
# git pull 전에 켠 서버(또는 그 서버를 띄운 예전 트레이)가 남아 있으면 새 화면(/studio 등)이 없다.
function Test-StaleSettings {
  $head = $null
  try { $head = (& git -C $Repo rev-parse HEAD 2>$null | Select-Object -First 1) } catch { }
  try {
    $info = Invoke-RestMethod -Uri "http://127.0.0.1:$SettingsPort/api/info" -TimeoutSec 3 -UseBasicParsing
  } catch {
    # 응답은 하는데 /api/info가 없으면 예전 서버, 아예 꺼져 있으면 오래된 게 아니다.
    return [bool]($_.Exception.Response)
  }
  if (-not $info.build) { return $true }
  return [bool]($head -and $info.build -ne $head)
}

# 설정 화면 포트를 쓰는 node 프로세스를 끈다(다른 프로그램은 건드리지 않는다).
function Stop-StaleSettings {
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $SettingsPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { return }
  foreach ($p in $pids) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 800
}

# 이미 켜져 있으면 하나만 둔다.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\NexusTray", [ref]$created)
$stale = Test-StaleSettings
if (-not $created -and $stale) {
  # 업데이트 전에 켠 트레이가 남아 있다. 그 트레이와 예전 서버를 끄고 새로 켠다.
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*nexus-tray.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  try { $created = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $created = $true }
}
if ($stale) { Stop-StaleSettings }
if (-not $created) {
  if ($OpenApp) { Open-App; exit 0 }
  [System.Windows.Forms.MessageBox]::Show("Nexus가 이미 켜져 있어요. 화면 오른쪽 아래 작업 표시줄의 N 아이콘을 눌러 주세요.", "Nexus") | Out-Null
  exit 0
}

$LogDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$PaperclipUrl = "http://localhost:$PaperclipPort"
$SettingsUrl = "http://127.0.0.1:$SettingsPort/"
$StartupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "Nexus.lnk"
$DesktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "Nexus.lnk"

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync("127.0.0.1", $port)
    return ($task.Wait(300) -and $client.Connected)
  } catch { return $false } finally { $client.Close() }
}

# 서비스 하나: 이름, 포트, 실행 명령, 우리가 띄운 프로세스, 최근 재시작 시각
function New-NexusService($name, $port, $command, $log) {
  return [pscustomobject]@{ Name = $name; Port = $port; Command = $command; Log = $log; Process = $null; Restarts = @(); Wanted = $true }
}

# Paperclip을 강제로 끄면 내장 데이터베이스(postgres.exe)가 남아
# 다음에 켤 때 "pre-existing shared memory block is still in use" 오류가 난다.
# Paperclip이 쓰는 embedded-postgres 패키지의 postgres.exe만 골라 끈다(따로 설치한 PostgreSQL은 건드리지 않는다).
function Stop-PaperclipDb {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like "*embedded-postgres*" -or $_.CommandLine -like "*paperclip*" })
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($procs.Count) { Start-Sleep -Milliseconds 800 }
  return $procs.Count
}

function Start-NexusService($svc) {
  if (Test-Port $svc.Port) { return "already" }
  if ($svc.Name -eq "Paperclip") { Stop-PaperclipDb | Out-Null }
  $line = "/d /s /c `"$($svc.Command) >> `"$($svc.Log)`" 2>&1`""
  Add-Content -Path $svc.Log -Value ("`r`n==== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " 시작 ====") -Encoding UTF8
  $svc.Process = Start-Process -FilePath "cmd.exe" -ArgumentList $line -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
  return "started"
}

function Stop-NexusService($svc) {
  if ($svc.Process -and -not $svc.Process.HasExited) {
    & taskkill.exe /PID $svc.Process.Id /T /F 2>&1 | Out-Null
    if ($svc.Name -eq "Paperclip") { Stop-PaperclipDb | Out-Null }
  }
  $svc.Process = $null
}

$env:NEXUS_NO_BROWSER = "1"
$env:NEXUS_SETTINGS_PORT = "$SettingsPort"
$services = @()
if (-not $NoPaperclip) {
  $services += New-NexusService "Paperclip" $PaperclipPort "npx --yes paperclipai@latest run" (Join-Path $LogDir "paperclip.log")
}
$settingsMain = Join-Path $Repo "apps\nexus-server\dist\main.mjs"
$services += New-NexusService "설정 화면" $SettingsPort "node scripts\build-settings.mjs && node `"$settingsMain`"" (Join-Path $LogDir "settings.log")

# ---------- 아이콘 ----------
function New-NexusIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString("N", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 1, 32, 32)), $fmt)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$IconOk = New-NexusIcon ([System.Drawing.Color]::FromArgb(36, 89, 214))
$IconWait = New-NexusIcon ([System.Drawing.Color]::FromArgb(138, 90, 0))
$IconBad = New-NexusIcon ([System.Drawing.Color]::FromArgb(179, 38, 30))

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $IconWait
$tray.Text = "Nexus: 켜는 중"
$tray.Visible = $true

function Notify($title, $text, $kind = "Info") {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = $text
  $tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$kind
  $tray.ShowBalloonTip(5000)
}

# ---------- 바로 가기 ----------
function New-Shortcut($path, [switch]$App) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $exe = Join-Path $Repo "Nexus.exe"
  if ($App -and (Test-Path $exe)) {
    # Nexus.exe가 있으면 아이콘이 붙은 실행 파일로 바로 가기를 만든다.
    $lnk.TargetPath = $exe
    $lnk.IconLocation = "$exe,0"
  } else {
    $lnk.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" + $(if ($App) { " -OpenApp" } else { "" })
  }
  $lnk.WorkingDirectory = $Repo
  $lnk.Description = if ($App) { "Nexus 앱: 스튜디오와 음성 비서를 엽니다 (꺼져 있으면 켭니다)" } else { "Nexus: Paperclip과 설정 화면을 켜 둡니다" }
  $lnk.Save()
}

# ---------- 메뉴 ----------
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item($text, $action) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $text
  $item.add_Click($action)
  $menu.Items.Add($item) | Out-Null
  return $item
}
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem "상태 확인 중..."
$statusItem.Enabled = $false
$menu.Items.Add($statusItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$openItem = Add-Item "Nexus 앱 열기 (스튜디오, 음성 비서)" { Open-App }
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
if (-not $NoPaperclip) { Add-Item "Paperclip 열기" { Open-App "http://127.0.0.1:$SettingsPort/paperclip" } | Out-Null }
Add-Item "음성 비서 열기" { Open-App "http://127.0.0.1:$SettingsPort/voice" } | Out-Null
Add-Item "Nexus 설정 열기 (모델, 사용량, 예산)" { Open-App $SettingsUrl } | Out-Null
Add-Item "기록(로그) 폴더 열기" { Start-Process explorer.exe $LogDir } | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
Add-Item "모두 다시 시작" {
  foreach ($s in $services) { Stop-NexusService $s; $s.Restarts = @() }
  Start-Sleep -Milliseconds 800
  foreach ($s in $services) { Start-NexusService $s | Out-Null }
  Notify "Nexus" "다시 시작했어요. 잠시 뒤 화면을 열어 주세요."
} | Out-Null
$autoItem = Add-Item "Windows를 켤 때 자동으로 실행" {
  if (Test-Path $StartupLink) { Remove-Item $StartupLink -Force; Notify "Nexus" "이제 Windows를 켤 때 자동으로 실행하지 않아요." }
  else { New-Shortcut $StartupLink; Notify "Nexus" "이제 Windows를 켜면 Nexus가 자동으로 실행돼요." }
  $autoItem.Checked = Test-Path $StartupLink
}
$autoItem.Checked = Test-Path $StartupLink
Add-Item "바탕 화면에 Nexus 앱 바로 가기 만들기" { New-Shortcut $DesktopLink -App; Notify "Nexus" "바탕 화면에 Nexus 바로 가기를 만들었어요. 두 번 누르면 Nexus 앱이 열려요." } | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
Add-Item "종료" {
  $timer.Stop()
  foreach ($s in $services) { Stop-NexusService $s }
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
} | Out-Null
$tray.ContextMenuStrip = $menu
$tray.add_MouseDoubleClick({ Open-App })

# ---------- 상태 확인과 자동 재시작 ----------
$script:announced = $false
function Update-Status {
  $parts = @()
  $allUp = $true
  foreach ($s in $services) {
    $up = Test-Port $s.Port
    if ($up) { $parts += "$($s.Name) 켜짐"; continue }
    $allUp = $false
    $ours = $s.Process -ne $null
    if ($ours -and -not $s.Process.HasExited) { $parts += "$($s.Name) 켜는 중"; continue }
    # 우리가 띄운 프로세스가 끝났거나 처음부터 꺼져 있으면 다시 켠다. 10분에 3번까지만.
    $now = Get-Date
    $s.Restarts = @($s.Restarts | Where-Object { ($now - $_).TotalMinutes -lt 10 })
    if ($s.Restarts.Count -ge 3) { $parts += "$($s.Name) 멈춤"; continue }
    if ($ours) { Notify "Nexus" "$($s.Name)이(가) 멈춰서 다시 켤게요. 계속 멈추면 기록 폴더의 로그를 확인해 주세요." "Warning" }
    $s.Restarts += $now
    Start-NexusService $s | Out-Null
    $parts += "$($s.Name) 켜는 중"
  }
  $stuck = @($services | Where-Object { $_.Restarts.Count -ge 3 -and -not (Test-Port $_.Port) }).Count -gt 0
  $tray.Icon = if ($allUp) { $IconOk } elseif ($stuck) { $IconBad } else { $IconWait }
  $text = "Nexus: " + ($parts -join ", ")
  $tray.Text = if ($text.Length -gt 63) { $text.Substring(0, 63) } else { $text }
  $statusItem.Text = ($parts -join " · ")
  if ($allUp -and -not $script:announced) {
    $script:announced = $true
    Notify "Nexus가 켜졌어요" "아이콘을 두 번 누르면 Nexus 앱이 열려요. 오른쪽 버튼을 누르면 메뉴가 나와요."
    if ($OpenApp) { Open-App }
  }
}

foreach ($s in $services) { Start-NexusService $s | Out-Null }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ try { Update-Status } catch { } })
$timer.Start()
Update-Status

$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
$tray.Dispose()
$mutex.ReleaseMutex()
