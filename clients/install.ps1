# Loreweaver terminal client — one-line installer (Windows / PowerShell).
#
#   irm https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1 | iex
#
# Same idea as install.sh: ensure bun, pull the client tarball (GitHub Release by default,
# AUTO-FALLING-BACK to the 1a7432.site mirror if GitHub is unreachable), `bun install`, drop
# a `loreweaver` launcher. No admin. Force a source with $env:TRPG_ORIGIN, or pin/roll
# back a GitHub release with $env:TRPG_RELEASE_TAG.
# Note: OpenTUI's terminal rendering is primarily tuned for Unix terminals; on
# Windows use Windows Terminal, and treat this path as best-effort.
#
# Override via env: TRPG_ORIGIN, TRPG_RELEASE_TAG, TRPG_HOME, TRPG_REGISTRY, TRPG_BIN,
# TRPG_LOCAL_SERVER_HOME.
$ErrorActionPreference = "Stop"

$EmbeddedReleaseTag = ""
$EmbeddedClientVersion = ""

function VersionFromReleaseTag($tag) {
  if ($tag -like "release-*") { return $tag.Substring(8) }
  if ($tag -match "^v[0-9]") { return $tag.Substring(1) }
  return ""
}

$Home_    = if ($env:TRPG_HOME)     { $env:TRPG_HOME }     else { Join-Path $HOME ".loreweaver" }
$Registry = if ($env:TRPG_REGISTRY) { $env:TRPG_REGISTRY } else { "https://registry.npmmirror.com" }
$BinDir   = if ($env:TRPG_BIN)      { $env:TRPG_BIN }      else { Join-Path $HOME ".loreweaver\bin" }
$LocalServerHome = if ($env:TRPG_LOCAL_SERVER_HOME) { $env:TRPG_LOCAL_SERVER_HOME } else { $Home_ }
$PinnedReleaseTag = if ($env:TRPG_RELEASE_TAG) { $env:TRPG_RELEASE_TAG } else { "" }
$InstallReleaseTag = if ($PinnedReleaseTag) { $PinnedReleaseTag } elseif ($EmbeddedReleaseTag) { $EmbeddedReleaseTag } else { "latest" }
$DerivedReleaseVersion = VersionFromReleaseTag $InstallReleaseTag
$ClientVersion = if ($env:TRPG_CLIENT_VERSION) { $env:TRPG_CLIENT_VERSION } elseif ($env:TRPG_RELEASE_VERSION) { $env:TRPG_RELEASE_VERSION } elseif ($DerivedReleaseVersion) { $DerivedReleaseVersion } else { $EmbeddedClientVersion }
$ServerReleaseTag = if ($env:TRPG_SERVER_RELEASE_TAG) { $env:TRPG_SERVER_RELEASE_TAG } else { $InstallReleaseTag }

# Distribution: default GitHub Release; TRPG_ORIGIN overrides the primary. Auto-fall-back to
# the 1a7432.site mirror if the primary is unreachable (e.g. GitHub from mainland China).
$Mirror  = "https://1a7432.site/trpg"
$Primary = if ($env:TRPG_ORIGIN) { $env:TRPG_ORIGIN } else { "" }
function TarballOf($o)   { if ($o) { "$o/loreweaver-client.tar.gz" } else { "https://github.com/1A7432/loreweaver/releases/download/$InstallReleaseTag/loreweaver-client.tar.gz" } }
function InstallerOf($o) {
  if ($o) { return "$o/install.ps1" }
  if ($PinnedReleaseTag) { return "https://github.com/1A7432/loreweaver/releases/download/$InstallReleaseTag/install.ps1" }
  return "https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1"
}
function DescOf($o)      { if ($o) { $o } else { "GitHub Release" } }

function Say([string]$m) { Write-Host "▸ $m" -ForegroundColor Yellow }
function PsQuote([string]$s) { "'" + ($s -replace "'", "''") + "'" }

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

# 2) client tarball — try the primary, fall back to the 1a7432.site mirror.
if (Test-Path (Join-Path $Home_ "clients")) { Remove-Item (Join-Path $Home_ "clients") -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$tar = Join-Path $env:TEMP "loreweaver-client.tar.gz"
function FetchClient($url) {   # tar.exe ships with Windows 10+
  try { Invoke-WebRequest $url -OutFile $tar -TimeoutSec 20; tar -xzf $tar -C $Home_; Remove-Item $tar -Force -ErrorAction SilentlyContinue; return $true }
  catch { Remove-Item $tar -Force -ErrorAction SilentlyContinue; return $false }
}
$Used = $Primary
Say "downloading client from $(DescOf $Primary)…"
if (FetchClient (TarballOf $Primary)) { }
elseif ($Primary -ne $Mirror) {
  Say "primary source unreachable — falling back to the 1a7432.site mirror…"
  if (FetchClient (TarballOf $Mirror)) { $Used = $Mirror }
  else { throw "could not fetch the client from GitHub or the mirror — check your network / proxy." }
}
else { throw "could not fetch the client from the mirror — check your network." }

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
$updInstaller = InstallerOf $Used   # re-update from whichever source actually worked
$updatePrefix = "`$env:TRPG_HOME=$(PsQuote $Home_); `$env:TRPG_BIN=$(PsQuote $BinDir); `$env:TRPG_REGISTRY=$(PsQuote $Registry); if (-not `$env:TRPG_LOCAL_SERVER_HOME) { `$env:TRPG_LOCAL_SERVER_HOME=$(PsQuote $LocalServerHome) }; "
if ($PinnedReleaseTag) { $updatePrefix += "`$env:TRPG_RELEASE_TAG=$(PsQuote $PinnedReleaseTag); " }
$updateInner = if ($Used) { "$updatePrefix`$env:TRPG_ORIGIN=$(PsQuote $Used); irm $updInstaller | iex" } else { "$updatePrefix irm $updInstaller | iex" }
$cmd = "@echo off`r`nset `"TRPG_HOME=$Home_`"`r`nset `"TRPG_BIN=$BinDir`"`r`nset `"TRPG_REGISTRY=$Registry`"`r`nset `"TRPG_CLIENT_VERSION=$ClientVersion`"`r`nset `"TRPG_RELEASE_VERSION=$ClientVersion`"`r`nset `"TRPG_SERVER_RELEASE_TAG=$ServerReleaseTag`"`r`nif not defined TRPG_LOCAL_SERVER_HOME set `"TRPG_LOCAL_SERVER_HOME=$LocalServerHome`"`r`n"
if ($PinnedReleaseTag) { $cmd += "if not defined TRPG_RELEASE_TAG set `"TRPG_RELEASE_TAG=$PinnedReleaseTag`"`r`n" }
$cmd += "if /I `"%1`"==`"update`" ( powershell -NoProfile -Command `"$updateInner`" & exit /b )`r`nbun run `"$entry`" %*"
Set-Content -Path (Join-Path $BinDir "loreweaver.cmd") -Value $cmd

Write-Host ""
Say "installed ✓"
Write-Host "  Launcher: $BinDir\loreweaver.cmd"
Write-Host "  Local server folder: $LocalServerHome"
Write-Host "  Add '$BinDir' to PATH, then run:  loreweaver   (update later with: loreweaver update)"
Write-Host ""
Write-Host "  In the connect screen, use:"
Write-Host "    ticket  <the p2p ticket your Keeper shared>   (or click 'Host locally & play' to run your own)"
Write-Host "    key     <the invite key your Keeper gave you>"
Write-Host "    name    <your nickname>"
