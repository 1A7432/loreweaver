# Loreweaver terminal client — one-line installer (Windows / PowerShell).
#
#   irm https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1 | iex
#
# Same idea as install.sh: ensure bun (runtime + package manager), pull the client
# tarball from the GitHub Release, `bun install`, drop a `loreweaver` launcher. No admin.
# In mainland China (GitHub slow/blocked) set $env:TRPG_ORIGIN='https://1a7432.site/trpg'.
# Note: OpenTUI's terminal rendering is primarily tuned for Unix terminals; on
# Windows use Windows Terminal, and treat this path as best-effort.
#
# Override via env: TRPG_ORIGIN, TRPG_HOME, TRPG_REGISTRY, TRPG_BIN.
$ErrorActionPreference = "Stop"

$Home_    = if ($env:TRPG_HOME)     { $env:TRPG_HOME }     else { Join-Path $HOME ".loreweaver" }
$Registry = if ($env:TRPG_REGISTRY) { $env:TRPG_REGISTRY } else { "https://registry.npmmirror.com" }
$BinDir   = if ($env:TRPG_BIN)      { $env:TRPG_BIN }      else { Join-Path $HOME ".loreweaver\bin" }

# Distribution source: GitHub by default; a mirror when TRPG_ORIGIN is set.
if ($env:TRPG_ORIGIN) {
  $TarballUrl   = "$($env:TRPG_ORIGIN)/loreweaver-client.tar.gz"
  $InstallerUrl = "$($env:TRPG_ORIGIN)/install.ps1"
  $SourceDesc   = $env:TRPG_ORIGIN
} else {
  $TarballUrl   = "https://github.com/1A7432/loreweaver/releases/latest/download/loreweaver-client.tar.gz"
  $InstallerUrl = "https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1"
  $SourceDesc   = "GitHub Release"
}

function Say([string]$m) { Write-Host "▸ $m" -ForegroundColor Yellow }

# 1) bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $env:Path = "$HOME\.bun\bin;$env:Path"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Say "installing bun (runtime + package manager)…"
  try { Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression }
  catch { throw "bun install failed. If GitHub is slow where you are, install bun manually from https://bun.sh then re-run." }
  $env:Path = "$HOME\.bun\bin;$env:Path"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun still not on PATH — open a new PowerShell and re-run." }
Say ("bun " + (bun --version) + " ready")

# 2) client tarball
Say "downloading client from $SourceDesc…"
if (Test-Path (Join-Path $Home_ "clients")) { Remove-Item (Join-Path $Home_ "clients") -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$tar = Join-Path $env:TEMP "loreweaver-client.tar.gz"
Invoke-WebRequest $TarballUrl -OutFile $tar
tar -xzf $tar -C $Home_          # tar.exe ships with Windows 10+
Remove-Item $tar -Force

# 3) deps
Say "installing dependencies (registry: $Registry)…"
Set-Content -Path (Join-Path $Home_ "clients\.npmrc") -Value "registry=$Registry"
Push-Location (Join-Path $Home_ "clients")
bun install --silent
Pop-Location

# 4) launcher — `loreweaver` (matches the project name). `loreweaver update` re-runs the
#    installer to fetch the latest client; anything else launches the TUI.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$entry = (Join-Path $Home_ "clients\tui\src\index.tsx")
$updateInner = if ($env:TRPG_ORIGIN) { "`$env:TRPG_ORIGIN='$($env:TRPG_ORIGIN)'; irm $InstallerUrl | iex" } else { "irm $InstallerUrl | iex" }
$cmd = "@echo off`r`nif /I `"%1`"==`"update`" ( powershell -NoProfile -Command `"$updateInner`" & exit /b )`r`nbun run `"$entry`" %*"
Set-Content -Path (Join-Path $BinDir "loreweaver.cmd") -Value $cmd

Write-Host ""
Say "installed ✓"
Write-Host "  Launcher: $BinDir\loreweaver.cmd"
Write-Host "  Add '$BinDir' to PATH, then run:  loreweaver   (update later with: loreweaver update)"
Write-Host ""
Write-Host "  In the connect screen, use:"
Write-Host "    host  wss://1a7432.site/ws"
Write-Host "    key   <the invite key your Keeper gave you>"
Write-Host "    name  <your nickname>"
