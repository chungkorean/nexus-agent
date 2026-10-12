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

# ---------- Nexus 앱 창 다루기 ----------
# 앱 창은 Edge/Chrome 앱 모드 창이라 단추를 직접 바꿀 수 없다. 대신 트레이가 창을 지켜보다가
# '_'(최소화)를 누르면 작업 표시줄에서 숨겨 트레이로 보내고, 'X'로 마지막 창을 닫으면 Nexus를 모두 끈다.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NxWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  // 창에 닫기(WM_CLOSE)를 보낸다. 트레이로 숨겨 둔 창을 Nexus를 끌 때 함께 닫는다.
  public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
  // 주어진 프로세스들의 제목 있는 브라우저 창(보이는 것만)
  public static IntPtr[] Visible(int[] pids) {
    var set = new HashSet<uint>();
    foreach (var p in pids) set.Add((uint)p);
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      var sb = new StringBuilder(64); GetClassName(h, sb, 64);
      if (sb.ToString() == "Chrome_WidgetWin_1") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@
$script:AppProfile = Join-Path $DataDir "app-profile"
$script:HiddenWindows = New-Object System.Collections.ArrayList
# 앱 창 전용 프로필로 뜬 브라우저 프로세스 번호
function Get-AppPids {
  $needle = $script:AppProfile.ToLower()
  return @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) } | ForEach-Object { [int]$_.ProcessId })
}
# 트레이로 숨긴 앱 창을 다시 보여 준다. 보여 준 창이 있으면 $true.
function Show-AppWindows {
  $shown = $false
  foreach ($h in @($script:HiddenWindows)) {
    if ([NxWin]::IsWindow($h)) { [NxWin]::ShowWindow($h, 5) | Out-Null; [NxWin]::ShowWindow($h, 9) | Out-Null; [NxWin]::SetForegroundWindow($h) | Out-Null; $shown = $true }
  }
  $script:HiddenWindows.Clear()
  if (-not $shown) {
    # 작업 표시줄에 최소화해 둔 창이 있으면 그것을 띄운다.
    $pids = Get-AppPids
    if ($pids.Count) {
      foreach ($h in [NxWin]::Visible([int[]]$pids)) { [NxWin]::ShowWindow($h, 9) | Out-Null; [NxWin]::SetForegroundWindow($h) | Out-Null; $shown = $true }
    }
  }
  return $shown
}

# ---------- 켜는 중 화면 ----------
# Nexus.exe로 켜면 앱 창이 뜰 때까지(Paperclip과 설정 화면이 켜질 때까지) 움직이는 막대가 있는 작은 창을 띄운다.
$script:splash = $null
function Show-Splash {
  $f = New-Object System.Windows.Forms.Form
  $f.FormBorderStyle = "None"
  $f.StartPosition = "CenterScreen"
  $f.Size = New-Object System.Drawing.Size(380, 150)
  $f.BackColor = [System.Drawing.Color]::White
  $f.TopMost = $true
  $f.ShowInTaskbar = $true
  $f.Text = "Nexus"
  $f.Padding = New-Object System.Windows.Forms.Padding(1)
  $f.add_Paint({ param($sender, $e) $e.Graphics.DrawRectangle([System.Drawing.Pens]::LightGray, 0, 0, $sender.Width - 1, $sender.Height - 1) })
  $t = New-Object System.Windows.Forms.Label
  $t.Text = "Nexus를 켜는 중이에요"
  $t.Font = New-Object System.Drawing.Font("Malgun Gothic", 13, [System.Drawing.FontStyle]::Bold)
  $t.ForeColor = [System.Drawing.Color]::FromArgb(31, 36, 48)
  $t.Location = New-Object System.Drawing.Point(24, 22)
  $t.AutoSize = $true
  $f.Controls.Add($t)
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Style = "Marquee"
  $bar.MarqueeAnimationSpeed = 25
  $bar.Location = New-Object System.Drawing.Point(26, 64)
  $bar.Size = New-Object System.Drawing.Size(328, 10)
  $f.Controls.Add($bar)
  $d = New-Object System.Windows.Forms.Label
  $d.Text = "Paperclip과 설정 화면을 켜고 있어요. 처음에는 1~2분 걸릴 수 있어요."
  $d.Font = New-Object System.Drawing.Font("Malgun Gothic", 9)
  $d.ForeColor = [System.Drawing.Color]::DimGray
  $d.Location = New-Object System.Drawing.Point(24, 88)
  $d.Size = New-Object System.Drawing.Size(340, 44)
  $f.Controls.Add($d)
  $script:splashDetail = $d
  $script:splash = $f
  $f.Show()
  # 숨김 창으로 실행됐으면(SW_HIDE) 첫 Show가 무시되므로 한 번 더 보이게 한다.
  [NxWin]::ShowWindow($f.Handle, 5) | Out-Null
  [System.Windows.Forms.Application]::DoEvents()
}
function Close-Splash {
  if ($script:splash) { $script:splash.Close(); $script:splash.Dispose(); $script:splash = $null }
}
# Edge(없으면 Chrome)의 앱 모드로 Nexus 화면을 주소창 없는 창으로 연다.
# 따로 쓰는 프로필이라 마이크 권한도 이 창에만 한 번 허락하면 된다.
function Open-App([string]$url = $AppUrl) {
  # 이미 열어 둔(트레이로 숨긴) 앱 창이 있으면 새로 열지 않고 그 창을 띄운다.
  if ($url -eq $AppUrl -and (Show-AppWindows)) { return }
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $browser) { Start-Process $url; return }
  Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=`"$script:AppProfile`"", "--window-size=1280,880", "--no-first-run", "--no-default-browser-check")
}

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# ---------- 버전 관리와 자동 업데이트 ----------
# 저장소 맨 위 package.json의 version이 Nexus 버전이다. GitHub(origin/main)의 version이 더 높을 때만
# 새 버전을 받는다. 받는 동안 "업데이트 중" 창을 띄우고, 받은 뒤 패키지 설치와 빌드까지 한다.
# 인터넷이 없거나 GitHub에 닿지 않으면 조용히 지금 버전으로 켠다. 끄려면 환경 변수 NEXUS_NO_UPDATE=1.
function Get-NexusVersion([string]$json) {
  try { return [version](($json | ConvertFrom-Json).version -replace "-.*$", "") } catch { return $null }
}
function Get-LocalVersion {
  return Get-NexusVersion ([IO.File]::ReadAllText((Join-Path $Repo "package.json")))
}
function Find-Update {
  if ($env:NEXUS_NO_UPDATE -eq "1" -or $env:NEXUS_JUST_UPDATED -eq "1") { return $null }
  if (-not (Test-Path (Join-Path $Repo ".git"))) { return $null }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $env:GIT_TERMINAL_PROMPT = "0"
  # 받는 동안 켜는 중 화면이 멈추지 않게 따로 돌리고 기다린다(12초가 넘으면 그만두고 지금 버전으로 켠다).
  $p = Start-Process -FilePath "git" -ArgumentList @("-C", "`"$Repo`"", "-c", "credential.interactive=never", "fetch", "--quiet", "origin", "main") -WindowStyle Hidden -PassThru
  $null = $p.Handle  # 종료 코드를 읽으려면 핸들을 잡아 둬야 한다
  $until = (Get-Date).AddSeconds(12)
  while (-not $p.HasExited -and (Get-Date) -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  if (-not $p.HasExited) { try { $p.Kill() } catch { }; return $null }
  if ($p.ExitCode -ne 0) { return $null }
  $ErrorActionPreference = "Continue"  # git이 오류를 내도 트레이가 멈추지 않게
  $remoteJson = (& git -C $Repo show origin/main:package.json 2>$null) -join "`n"
  $remote = Get-NexusVersion $remoteJson
  $local = Get-LocalVersion
  if ($remote -and $local -and $remote -gt $local) { return $remote }
  return $null
}
# 새 버전으로 바꾼다. 보이는 창에서 진행 상황을 보여 주고, 끝날 때까지 기다린다. 성공하면 $true.
function Install-Update($version) {
  Close-Splash
  $logFile = Join-Path $DataDir "logs\update.log"
  New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
  # Nexus.exe가 아직 끝나지 않았으면 새 Nexus.exe로 바꾸지 못하므로 잠깐 기다린다.
  Start-Sleep -Milliseconds 1500
  $steps = @(
    "title Nexus 업데이트 중",
    "echo.",
    "echo   Nexus를 새 버전 $version (으)로 업데이트하는 중이에요.",
    "echo   이 창이 저절로 닫힐 때까지 기다려 주세요. 몇 분 걸릴 수 있어요.",
    "echo.",
    "git -c credential.interactive=never pull --ff-only",
    "npx --yes pnpm@10 install",
    "npx --yes pnpm@10 build"
  ) -join " && "
  $fail = "(echo. & echo   업데이트하지 못했어요. 위 오류를 확인한 뒤 아무 키나 누르면 지금 버전으로 켤게요. & pause & exit /b 1)"
  $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /c `"$steps || $fail`"" -WorkingDirectory $Repo -PassThru -Wait
  Add-Content -Path $logFile -Encoding UTF8 -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " 업데이트 $version : 종료 코드 " + $p.ExitCode)
  return ($p.ExitCode -eq 0)
}
# 새 트레이 실행기로 다시 켠다(받은 새 실행기 내용을 쓰려고). 새 실행기가 예전 서버와 이 트레이를 정리한다.
function Restart-Tray {
  $env:NEXUS_JUST_UPDATED = "1"
  $argList = @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-PaperclipPort", $PaperclipPort, "-SettingsPort", $SettingsPort)
  if ($OpenApp) { $argList += "-OpenApp" }
  if ($NoPaperclip) { $argList += "-NoPaperclip" }
  Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $argList -WindowStyle Hidden
}

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

# 이미 켜진 트레이가 있고 같은 버전이면, 그 트레이에 앱 창을 열어 달라고 알리고 바로 끝낸다.
# (예전에는 새로 켠 쪽이 따로 창을 열어서, 처음 트레이가 숨겨 둔 창이 남아 X로 꺼지지 않을 때가 있었다.)
$showEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\NexusTrayShow")
$running = $null
if ([System.Threading.Mutex]::TryOpenExisting("Local\NexusTray", [ref]$running)) {
  $running.Dispose()
  if (-not (Test-StaleSettings)) {
    if ($OpenApp) { [void]$showEvent.Set(); exit 0 }
    [System.Windows.Forms.MessageBox]::Show("Nexus가 이미 켜져 있어요. 화면 오른쪽 아래 작업 표시줄의 N 아이콘을 눌러 주세요.", "Nexus") | Out-Null
    exit 0
  }
}

if ($OpenApp) { Show-Splash }
if ($script:splash) { $script:splashDetail.Text = "새 버전이 있는지 확인하는 중이에요." ; [System.Windows.Forms.Application]::DoEvents() }
$update = Find-Update
if ($update) {
  if (Install-Update $update) { Restart-Tray; exit 0 }
}
$env:NEXUS_JUST_UPDATED = $null

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
  if ($OpenApp) { Close-Splash; [void]$showEvent.Set(); exit 0 }
  [System.Windows.Forms.MessageBox]::Show("Nexus가 이미 켜져 있어요. 화면 오른쪽 아래 작업 표시줄의 N 아이콘을 눌러 주세요.", "Nexus") | Out-Null
  exit 0
}

$LogDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
# 앱 창과 켜고 끄는 일을 기록한다(X로 안 꺼지거나 오래 걸릴 때 원인을 찾으려고).
$AppLog = Join-Path $LogDir "app-windows.log"
function Write-AppLog([string]$text) {
  try { Add-Content -Path $AppLog -Encoding UTF8 -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $text) } catch { }
}
$script:startedAt = Get-Date
Write-AppLog ("트레이 켬 (버전 " + (Get-LocalVersion) + ", 폴더 " + $Repo + ")")
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
  # taskkill이 "자식 프로세스를 끝내지 못했어요" 같은 말을 오류 출력에 쓰면 PowerShell 5.1은 그것을 예외로 바꾼다.
  # 그러면 종료가 중간에 멈춰 X를 눌러도 트레이가 남았다. 여기서는 오류를 무시하고 끝까지 끈다.
  $ErrorActionPreference = "Continue"
  if ($svc.Process -and -not $svc.Process.HasExited) {
    try { Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", $svc.Process.Id, "/T", "/F") -WindowStyle Hidden -Wait } catch { }
    if ($svc.Name -eq "Paperclip") { try { Stop-PaperclipDb | Out-Null } catch { } }
  }
  $svc.Process = $null
  # 이 트레이가 띄우지 않은(예전 트레이나 직접 켠) 설정 화면이 남아 있으면 새로 켜지지 않으므로 그것도 끈다.
  if ($svc.Port -eq $SettingsPort -and (Test-Port $SettingsPort)) { Stop-StaleSettings }
}

$env:NEXUS_NO_BROWSER = "1"
$env:NEXUS_SETTINGS_PORT = "$SettingsPort"
$services = @()
if (-not $NoPaperclip) {
    # 한 번 설치해 둔 Paperclip을 바로 켠다(새 버전은 켜진 뒤 뒤에서 받아 다음에 씀). scripts\paperclip-run.mjs 참고.
  $services += New-NexusService "Paperclip" $PaperclipPort "node scripts\paperclip-run.mjs run" (Join-Path $LogDir "paperclip.log")
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
Add-Item ("새 버전 확인 (지금 버전 " + (Get-LocalVersion) + ")") {
  $v = Find-Update
  if (-not $v) { Notify "Nexus" ("지금 버전 " + (Get-LocalVersion) + "이 최신이에요."); return }
  if (Install-Update $v) { Restart-Tray } else { Notify "Nexus" "업데이트하지 못했어요. 기록(로그) 폴더의 update.log를 확인해 주세요." "Warning" }
} | Out-Null
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
function Stop-All([string]$why = "메뉴의 종료") {
  # 어느 단계에서 오류가 나도 끝까지 가서 반드시 트레이를 끈다.
  $ErrorActionPreference = "Continue"
  Write-AppLog ("모두 끔: " + $why)
  try { $timer.Stop() } catch { }
  try { if ($appTimer) { $appTimer.Stop() } } catch { }
  try { if ($showTimer) { $showTimer.Stop() } } catch { }
  try { $tray.Visible = $false } catch { }
  Close-Splash
  # 트레이로 숨겨 둔 창도 닫는다(그대로 두면 보이지 않는 브라우저가 남는다).
  foreach ($h in @($script:HiddenWindows)) { try { [NxWin]::Close($h) } catch { } }
  foreach ($s in $services) { try { Stop-NexusService $s } catch { } }
  [System.Windows.Forms.Application]::Exit()
}
Add-Item "종료" { Stop-All } | Out-Null
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
  if ($script:splash) {
    $detail = ($parts -join " · ")
    # Paperclip을 처음 설치하는 중이면 알려 준다(scripts\paperclip-run.mjs가 남기는 상태).
    $pcStatus = Join-Path $DataDir "paperclip\status.txt"
    if ((Test-Path $pcStatus) -and ((Get-Content $pcStatus -Raw -ErrorAction SilentlyContinue) -like "installing*")) { $detail = "Paperclip을 처음 설치하는 중이에요. 몇 분 걸릴 수 있어요." }
    $script:splashDetail.Text = $detail
  }
  if ($allUp -and -not $script:announced) {
    $script:announced = $true
    Write-AppLog ("모두 켜짐 (" + [int]((Get-Date) - $script:startedAt).TotalSeconds + "초)")
    Close-Splash
    Notify "Nexus가 켜졌어요" "아이콘을 두 번 누르면 Nexus 앱이 열려요. 오른쪽 버튼을 누르면 메뉴가 나와요."
    if ($OpenApp -or $script:openWhenUp) { $script:openWhenUp = $false; Open-App }
  }
}

foreach ($s in $services) { Start-NexusService $s | Out-Null }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ try { Update-Status } catch { } })
$timer.Start()
Update-Status

# 앱 창 지켜보기: '_'는 트레이로 숨기고, 보이던 창을 'X'로 모두 닫으면 다 끈다.
# 무슨 일이 있었는지 기록(로그) 폴더의 app-windows.log에 남긴다.
$script:appSeen = $false
$script:appGone = 0
$script:lastShown = 0
$script:hideTold = $false
$script:appSig = ""
function Watch-AppWindows {
  $pids = Get-AppPids
  $visible = if ($pids.Count) { @([NxWin]::Visible([int[]]$pids)) } else { @() }
  $minimized = 0
  foreach ($h in $visible) {
    if ([NxWin]::IsIconic($h)) {
      $minimized++
      [NxWin]::ShowWindow($h, 0) | Out-Null
      if (-not $script:HiddenWindows.Contains($h)) { [void]$script:HiddenWindows.Add($h) }
      if (-not $script:hideTold) { $script:hideTold = $true; Notify "Nexus" "창을 트레이로 숨겼어요. N 아이콘을 두 번 누르면 다시 열려요. 완전히 끄려면 창의 X를 누르세요." }
    }
  }
  $shownWin = @($visible | Where-Object { -not [NxWin]::IsIconic($_) -and [NxWin]::IsWindowVisible($_) })
  $hidden = @($script:HiddenWindows | Where-Object { [NxWin]::IsWindow($_) })
  $sig = "보이는 창 " + $shownWin.Count + " (" + (($shownWin | ForEach-Object { [NxWin]::Title($_) }) -join " | ") + "), 숨긴 창 " + $hidden.Count + ", 브라우저 프로세스 " + $pids.Count
  if ($sig -ne $script:appSig) { $script:appSig = $sig; Write-AppLog $sig }
  if ($shownWin.Count -gt 0) { $script:appSeen = $true; $script:appGone = 0; $script:lastShown = $shownWin.Count; return }
  if (-not $script:appSeen) { return }
  # 방금 '_'로 숨겼거나, 전부 숨겨 둔 상태면 그대로 둔다.
  if ($hidden.Count -gt 0 -and ($minimized -gt 0 -or $script:lastShown -eq 0)) { $script:lastShown = 0; $script:appGone = 0; return }
  # 보이던 창이 사라졌다(X). 페이지를 옮길 때 잠깐 안 보일 수 있어 두 번 연속일 때만 끈다.
  $script:appGone++
  if ($script:appGone -ge 2) { Stop-All "앱 창을 X로 닫음" }
}
# 나중에 Nexus.exe를 다시 누르면 그 실행기가 이 트레이에 알린다. 숨긴 창을 다시 보여 주거나 새로 연다.
$script:openWhenUp = $false
$showTimer = New-Object System.Windows.Forms.Timer
$showTimer.Interval = 400
$showTimer.add_Tick({
  try {
    if (-not $showEvent.WaitOne(0)) { return }
    if ($script:announced) { Open-App } else { $script:openWhenUp = $true }
  } catch { }
})
$showTimer.Start()
$appTimer = New-Object System.Windows.Forms.Timer
$appTimer.Interval = 2000
$appTimer.add_Tick({ try { Watch-AppWindows } catch { } })
$appTimer.Start()
# 오래 걸리면 켜는 중 화면을 닫고 트레이 아이콘으로 상태를 보게 한다.
$splashTimer = New-Object System.Windows.Forms.Timer
$splashTimer.Interval = 240000
$splashTimer.add_Tick({ $splashTimer.Stop(); if ($script:splash) { Close-Splash; Notify "Nexus" "켜는 데 오래 걸리고 있어요. 트레이 N 아이콘에 마우스를 올리면 상태가 보여요." "Warning" } })
$splashTimer.Start()

$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
$tray.Dispose()
$mutex.ReleaseMutex()
