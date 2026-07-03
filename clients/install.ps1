# Loreweaver terminal client — one-line installer (Windows / PowerShell).
#
#   irm https://1a7432.site/trpg/install.ps1 | iex
#
# Same idea as install.sh: ensure bun (runtime + package manager), pull the client
# SOURCE from your server, `bun install`, drop a `trpg-kp` launcher. No admin needed.
# Note: OpenTUI's terminal rendering is primarily tuned for Unix terminals; on
# Windows use Windows Terminal, and treat this path as best-effort.
#
# Override via env: TRPG_ORIGIN, TRPG_HOME, TRPG_REGISTRY, TRPG_BIN.
$ErrorActionPreference = "Stop"

$Origin   = if ($env:TRPG_ORIGIN)   { $env:TRPG_ORIGIN }   else { "https://1a7432.site/trpg" }
$Home_    = if ($env:TRPG_HOME)     { $env:TRPG_HOME }     else { Join-Path $HOME ".trpg-kp" }
$Registry = if ($env:TRPG_REGISTRY) { $env:TRPG_REGISTRY } else { "https://registry.npmmirror.com" }
$BinDir   = if ($env:TRPG_BIN)      { $env:TRPG_BIN }      else { Join-Path $HOME ".trpg-kp\bin" }

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

# 2) client source from your server
Say "downloading client source from $Origin…"
if (Test-Path (Join-Path $Home_ "clients")) { Remove-Item (Join-Path $Home_ "clients") -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$tar = Join-Path $env:TEMP "trpg-kp-client.tar.gz"
Invoke-WebRequest "$Origin/trpg-kp-client.tar.gz" -OutFile $tar
tar -xzf $tar -C $Home_          # tar.exe ships with Windows 10+
Remove-Item $tar -Force

# 3) deps
Say "installing dependencies (registry: $Registry)…"
Set-Content -Path (Join-Path $Home_ "clients\.npmrc") -Value "registry=$Registry"
Push-Location (Join-Path $Home_ "clients")
bun install --silent
Pop-Location

# 4) launcher
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$entry = (Join-Path $Home_ "clients\tui\src\index.tsx")
Set-Content -Path (Join-Path $BinDir "trpg-kp.cmd") -Value "@echo off`r`nbun run `"$entry`" %*"

Write-Host ""
Say "installed ✓"
Write-Host "  Launcher: $BinDir\trpg-kp.cmd"
Write-Host "  Add '$BinDir' to PATH, then run:  trpg-kp"
Write-Host ""
Write-Host "  In the connect screen, use:"
Write-Host "    host  wss://1a7432.site/ws"
Write-Host "    key   <the invite key your Keeper gave you>"
Write-Host "    name  <your nickname>"
