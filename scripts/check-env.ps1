# Nexus-Agent 0단계 환경 점검 (Windows PowerShell 5.1 이상)
# 사용법: PowerShell에서  powershell -ExecutionPolicy Bypass -File scripts\check-env.ps1
param(
  [string]$PaperclipUrl = "http://localhost:3100"
)

$ok = 0; $warn = 0; $fail = 0
function Pass($msg) { Write-Host "  [통과] $msg" -ForegroundColor Green; $script:ok++ }
function Warn($msg) { Write-Host "  [주의] $msg" -ForegroundColor Yellow; $script:warn++ }
function Fail($msg) { Write-Host "  [실패] $msg" -ForegroundColor Red; $script:fail++ }

function Get-Version($cmd, $arg) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $c) { return $null }
  try { return (& $cmd $arg 2>&1 | Select-Object -First 1).ToString().Trim() } catch { return "" }
}

Write-Host "`nNexus-Agent 환경 점검`n" -ForegroundColor Cyan

Write-Host "1. 기본 도구"
$node = Get-Version "node" "--version"
if (-not $node) { Fail "Node.js가 없어요. https://nodejs.org 에서 24.11 이상을 설치하세요." }
else {
  $v = [version]($node.TrimStart("v"))
  if ($v -ge [version]"24.11.0") { Pass "Node.js $node" }
  else { Fail "Node.js $node 은(는) 낮아요. Paperclip은 24.11 이상이 필요해요." }
}
$pnpm = Get-Version "pnpm" "--version"
if ($pnpm) { Pass "pnpm $pnpm" } else { Warn "pnpm이 없어요. 'npm install -g pnpm' 으로 설치하세요." }
$git = Get-Version "git" "--version"
if ($git) { Pass $git } else { Fail "git이 없어요. https://git-scm.com 에서 설치하세요." }
$longpaths = (git config --global --get core.longpaths) 2>$null
if ($longpaths -eq "true") { Pass "git core.longpaths 켜짐" } else { Warn "긴 경로 문제를 막으려면: git config --global core.longpaths true" }

Write-Host "`n2. 실행 엔진"
$oc = Get-Version "opencode" "--version"
if ($oc) { Pass "OpenCode $oc" } else { Fail "OpenCode가 없어요. 'npm install -g opencode-ai' 로 설치하세요." }
$cc = Get-Version "claude" "--version"
if ($cc) { Pass "Claude Code $cc" } else { Fail "Claude Code가 없어요. 'npm install -g @anthropic-ai/claude-code' 로 설치한 뒤 'claude' 를 실행해 로그인하세요." }
if ($env:ANTHROPIC_API_KEY) { Warn "ANTHROPIC_API_KEY가 설정돼 있어요. Nexus는 구독 계정을 쓰도록 실행할 때 이 값을 지웁니다." }

Write-Host "`n3. Paperclip"
try {
  $r = Invoke-WebRequest -Uri $PaperclipUrl -UseBasicParsing -TimeoutSec 5
  Pass "Paperclip 응답 확인 ($PaperclipUrl, 상태 $($r.StatusCode))"
} catch {
  Warn "Paperclip이 $PaperclipUrl 에서 응답하지 않아요. 'npx paperclipai@latest onboard --yes' 로 설치·실행했는지 확인하세요. 안 되면 WSL2로 옮길지 정합니다."
}

Write-Host "`n4. 계정 폴더 분리 (수동 확인)"
Write-Host "  - Claude 계정을 두 개 쓰려면 PowerShell에서:"
Write-Host "      `$env:CLAUDE_CONFIG_DIR = `"$env:LOCALAPPDATA\Nexus\accounts\claude-work`"; claude"
Write-Host "    로 로그인한 뒤, 다른 폴더로 한 번 더 로그인해 서로 다른 계정이 유지되는지 확인하세요."
Write-Host "  - OpenCode도 같은 방식으로 `$env:XDG_DATA_HOME 을 바꿔 'opencode auth login' 후 'opencode auth list' 로 확인하세요."

Write-Host "`n결과: 통과 $ok, 주의 $warn, 실패 $fail`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 } else { exit 0 }
