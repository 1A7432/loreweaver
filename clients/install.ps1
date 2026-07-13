# Loreweaver terminal client — one-line installer (Windows / PowerShell).
#
#   irm https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1 | iex
#
# Same idea as install.sh: ensure bun, pull the client tarball (GitHub Release by default,
# AUTO-FALLING-BACK to the 1a7432.site mirror if GitHub is unavailable), `bun install`, drop
# a `loreweaver` launcher. No admin. Force a source with $env:TRPG_ORIGIN, or pin/roll
# back a release with $env:TRPG_RELEASE_TAG. HTTP mirrors expose immutable assets under
# `releases/<tag>/`; an embedded digest is valid only for its matching embedded tag.
# Note: OpenTUI's terminal rendering is primarily tuned for Unix terminals; on
# Windows use Windows Terminal, and treat this path as best-effort.
#
# Override via env: TRPG_ORIGIN, TRPG_RELEASE_TAG, TRPG_HOME, TRPG_REGISTRY, TRPG_BIN,
# TRPG_LOCAL_SERVER_HOME.
$ErrorActionPreference = "Stop"

$EmbeddedReleaseTag = ""
$EmbeddedClientVersion = ""
$EmbeddedClientSha256 = ""

function VersionFromReleaseTag($tag) {
  if ($tag -like "release-*") { return $tag.Substring(8) }
  if ($tag -match "^v[0-9]") { return $tag.Substring(1) }
  return ""
}

$Home_    = if ($env:TRPG_HOME)     { $env:TRPG_HOME }     else { Join-Path $HOME ".loreweaver" }
$Registry = if ($env:TRPG_REGISTRY) { $env:TRPG_REGISTRY } else { "https://registry.npmjs.org" }
$BinDir   = if ($env:TRPG_BIN)      { $env:TRPG_BIN }      else { Join-Path $HOME ".loreweaver\bin" }
$LocalServerHome = if ($env:TRPG_LOCAL_SERVER_HOME) { $env:TRPG_LOCAL_SERVER_HOME } else { $Home_ }
$PinnedReleaseTag = if ($env:TRPG_RELEASE_TAG) { $env:TRPG_RELEASE_TAG } else { "" }
$InstallReleaseTag = if ($PinnedReleaseTag) { $PinnedReleaseTag } elseif ($EmbeddedReleaseTag) { $EmbeddedReleaseTag } else { "latest" }
$DerivedReleaseVersion = VersionFromReleaseTag $InstallReleaseTag
$ClientVersion = if ($env:TRPG_CLIENT_VERSION) { $env:TRPG_CLIENT_VERSION } elseif ($env:TRPG_RELEASE_VERSION) { $env:TRPG_RELEASE_VERSION } elseif ($DerivedReleaseVersion) { $DerivedReleaseVersion } else { $EmbeddedClientVersion }
$ServerReleaseTag = if ($env:TRPG_SERVER_RELEASE_TAG) { $env:TRPG_SERVER_RELEASE_TAG } else { $InstallReleaseTag }

# Distribution: default GitHub Release; TRPG_ORIGIN overrides the primary. Auto-fall-back to
# the 1a7432.site mirror if the primary is unavailable (e.g. GitHub from mainland China).
# Concrete tags use `releases/<tag>/` on mirrors; only the literal `latest` target uses the
# flat compatibility path.
$Mirror  = "https://1a7432.site/trpg"
$Primary = if ($env:TRPG_ORIGIN) { $env:TRPG_ORIGIN } else { "" }
if (($InstallReleaseTag -ne "latest") -and ($InstallReleaseTag -notmatch '^[A-Za-z0-9._+-]+$')) {
  throw "TRPG_RELEASE_TAG contains characters that are unsafe in a release URL"
}
try {
  if ($Registry.Contains("`r") -or $Registry.Contains("`n")) { throw "registry URL contains newlines" }
  $registryUri = [Uri]$Registry
  if ((-not $registryUri.IsAbsoluteUri) -or ($registryUri.Scheme -notin @("http", "https")) -or $registryUri.UserInfo) {
    throw "invalid registry URL"
  }
  $Registry = $Registry.TrimEnd("/")
}
catch { throw "TRPG_REGISTRY must be an http(s) URL without embedded credentials" }
if ($Primary) {
  if ($Primary.Contains("`r") -or $Primary.Contains("`n")) { throw "TRPG_ORIGIN must not contain newlines" }
  try {
    $originUri = [Uri]$Primary
    if ((-not $originUri.IsAbsoluteUri) -or ($originUri.Scheme -notin @("http", "https")) -or $originUri.UserInfo) {
      throw "invalid origin URL"
    }
  }
  catch { throw "TRPG_ORIGIN must be an http(s) URL without embedded credentials" }
}
function ReleaseBaseOf($o) {
  if ($o) {
    $origin = $o.TrimEnd("/")
    if ($InstallReleaseTag -eq "latest") { return $origin }
    return "$origin/releases/$InstallReleaseTag"
  }
  if ($InstallReleaseTag -eq "latest") { return "https://github.com/1A7432/loreweaver/releases/latest/download" }
  return "https://github.com/1A7432/loreweaver/releases/download/$InstallReleaseTag"
}
function TarballOf($o)   { "$(ReleaseBaseOf $o)/loreweaver-client.tar.gz" }
function InstallerOf($o) {
  # The release tag embedded by CI identifies this installer's verified payload;
  # only an explicit TRPG_RELEASE_TAG is a lasting operator pin. Otherwise an
  # install that fell back to the mirror must still follow its flat/latest installer.
  if ($o) {
    $origin = $o.TrimEnd("/")
    if ($PinnedReleaseTag) { return "$origin/releases/$InstallReleaseTag/install.ps1" }
    return "$origin/install.ps1"
  }
  if ($PinnedReleaseTag) { return "https://github.com/1A7432/loreweaver/releases/download/$InstallReleaseTag/install.ps1" }
  return "https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1"
}
function DescOf($o)      { if ($o) { $o } else { "GitHub Release" } }

function Say([string]$m) { Write-Host "▸ $m" -ForegroundColor Yellow }
function PsQuote([string]$s) { "'" + ($s -replace "'", "''") + "'" }

function RewriteLockRegistry($ClientsRoot) {
  # bun.lock stores absolute package URLs; writing .npmrc alone cannot redirect
  # those entries. Rewrite the installed copy before bun resolves dependencies.
  $lock = Join-Path $ClientsRoot "bun.lock"
  if (-not (Test-Path $lock)) { return }
  $previousFile = $env:TRPG_LOCK_FILE
  $previousRegistry = $env:TRPG_LOCK_REGISTRY
  try {
    $env:TRPG_LOCK_FILE = $lock
    $env:TRPG_LOCK_REGISTRY = $Registry
    bun -e '
      const path = process.env.TRPG_LOCK_FILE;
      let registry;
      try {
        const url = new URL(process.env.TRPG_LOCK_REGISTRY || "");
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) process.exit(2);
        registry = url.toString().replace(/\/+$/, "");
      } catch {
        process.exit(2);
      }
      if (!path || !registry) process.exit(2);
      let contents = await Bun.file(path).text();
      contents = contents.replace(
        /https:\/\/registry\.(?:npmjs\.org|npmmirror\.com)(?=\/)/g,
        () => registry,
      );
      await Bun.write(path, contents);
    '
    if ($LASTEXITCODE -ne 0) { throw "could not apply TRPG_REGISTRY to the client lockfile." }
  }
  finally {
    $env:TRPG_LOCK_FILE = $previousFile
    $env:TRPG_LOCK_REGISTRY = $previousRegistry
  }
}

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

# 2) Client tarball. As on Unix, only source availability failures may fall back.
# Invalid checksum metadata, a digest mismatch, or extraction failure is fatal.
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$StagingRoot = Join-Path $Home_ (".client-install-" + [guid]::NewGuid().ToString("N"))
$StagedClients = Join-Path $StagingRoot "payload\clients"
$tar = Join-Path $StagingRoot "loreweaver-client.tar.gz"
$LauncherStage = ""
$PreserveStaging = $false
New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null
try {
function TestClientArchive($archive) {
  $entries = @(& tar -tzf $archive 2>$null)
  if (($LASTEXITCODE -ne 0) -or ($entries.Count -eq 0)) { return $false }
  foreach ($rawEntry in $entries) {
    $entry = ([string]$rawEntry).Replace("\", "/")
    while ($entry.StartsWith("./")) { $entry = $entry.Substring(2) }
    if ((-not $entry) -or $entry.StartsWith("/") -or ($entry -match '^[A-Za-z]:') -or (($entry -split '/') -contains "..")) {
      return $false
    }
    if (($entry -ne "clients") -and (-not $entry.StartsWith("clients/"))) { return $false }
  }
  # The client release contains no links or special nodes. Reject them before
  # extraction so a safe-looking child path cannot pivot through a symlink.
  $verbose = @(& tar -tvzf $archive 2>$null)
  if (($LASTEXITCODE -ne 0) -or ($verbose.Count -eq 0)) { return $false }
  foreach ($lineValue in $verbose) {
    $line = [string]$lineValue
    if ((-not $line) -or (($line[0] -ne '-') -and ($line[0] -ne 'd'))) { return $false }
  }
  return $true
}
function ExpectedSha256($url, $targetTag) {
  if ($EmbeddedClientSha256 -and $EmbeddedReleaseTag -and ($targetTag -ceq $EmbeddedReleaseTag)) {
    return $EmbeddedClientSha256.ToLowerInvariant()
  }
  $sidecar = "$tar.sha256"
  try {
    Invoke-WebRequest "$url.sha256" -OutFile $sidecar -TimeoutSec 20 | Out-Null
    return ((Get-Content $sidecar -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
  }
  finally { Remove-Item $sidecar -Force -ErrorAction SilentlyContinue }
}
function FetchClient($url, $targetTag) {   # tar.exe ships with Windows 10+
  $script:FetchError = ""
  Remove-Item (Join-Path $StagingRoot "payload") -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot "payload") | Out-Null
  try {
    Invoke-WebRequest $url -OutFile $tar -TimeoutSec 20 | Out-Null
  }
  catch {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "could not download the client archive from $url"
    return "unavailable"
  }
  try {
    $expected = ExpectedSha256 $url $targetTag
  }
  catch {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "could not download the SHA-256 sidecar for $url"
    return "unavailable"
  }
  if ($expected -notmatch '^[0-9a-f]{64}$') {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "invalid SHA-256 metadata for the client archive"
    return "fatal"
  }
  $actual = (Get-FileHash -Algorithm SHA256 $tar).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "client archive SHA-256 mismatch; refusing to install"
    return "fatal"
  }
  if (-not (TestClientArchive $tar)) {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "verified client archive contains an unsafe path or entry type"
    return "fatal"
  }
  & tar -xzf $tar -C (Join-Path $StagingRoot "payload")
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $tar -Force -ErrorAction SilentlyContinue
    $script:FetchError = "extracting the verified client archive failed"
    return "fatal"
  }
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  if ((-not (Test-Path (Join-Path $StagedClients "package.json") -PathType Leaf)) -or
      (-not (Test-Path (Join-Path $StagedClients "bun.lock") -PathType Leaf)) -or
      (-not (Test-Path (Join-Path $StagedClients "tui\src\index.tsx") -PathType Leaf))) {
    $script:FetchError = "verified client archive has an unexpected layout"
    return "fatal"
  }
  return "ok"
}
$Used = $Primary
Say "downloading client from $(DescOf $Primary)…"
$result = FetchClient (TarballOf $Primary) $InstallReleaseTag
if ($result -eq "ok") { }
elseif (($result -eq "unavailable") -and ($Primary -ne $Mirror)) {
  Say "primary source unavailable — falling back to the 1a7432.site mirror…"
  $result = FetchClient (TarballOf $Mirror) $InstallReleaseTag
  if ($result -eq "ok") { $Used = $Mirror }
  elseif ($result -eq "unavailable") { throw "could not fetch the client or its checksum from GitHub or the mirror — check your network / proxy." }
  else { throw "$FetchError; refusing to install." }
}
elseif ($result -eq "unavailable") { throw "could not fetch the client or its checksum from the mirror — check your network." }
else { throw "$FetchError; refusing to install." }

# 3) deps
Say "installing dependencies (registry: $Registry)…"
[IO.File]::WriteAllText((Join-Path $StagedClients ".npmrc"), "registry=$Registry`n", [Text.UTF8Encoding]::new($false))
RewriteLockRegistry $StagedClients
Push-Location $StagedClients
try {
  & bun install --silent
  $bunInstallExit = $LASTEXITCODE
}
finally { Pop-Location }
if ($bunInstallExit -ne 0) { throw "bun install failed. Try again, or set TRPG_REGISTRY to another mirror." }

# 4) launcher — `loreweaver` (matches the project name). `loreweaver update` re-runs the
#    installer to fetch the latest client; anything else launches the TUI.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$entry = (Join-Path $Home_ "clients\tui\src\index.tsx")
$updInstaller = InstallerOf $Used   # re-update from whichever source actually worked
function AssertLauncherValue([string]$name, [string]$value) {
  if ($value.Contains("`r") -or $value.Contains("`n") -or $value.Contains('"')) {
    throw "$name contains characters that cannot be represented safely in the launcher"
  }
}
function CmdEscape([string]$value) { $value.Replace("%", "%%") }
$launcherValues = @{
  "TRPG_HOME" = $Home_; "TRPG_BIN" = $BinDir; "TRPG_REGISTRY" = $Registry
  "TRPG_LOCAL_SERVER_HOME" = $LocalServerHome; "TRPG_CLIENT_VERSION" = $ClientVersion
  "TRPG_SERVER_RELEASE_TAG" = $ServerReleaseTag; "TRPG_RELEASE_TAG" = $PinnedReleaseTag
  "TRPG_ORIGIN" = $Used; "installer URL" = $updInstaller; "client entry" = $entry
}
foreach ($name in $launcherValues.Keys) { AssertLauncherValue $name $launcherValues[$name] }
$updatePrefix = "`$env:TRPG_HOME=$(PsQuote $Home_); `$env:TRPG_BIN=$(PsQuote $BinDir); `$env:TRPG_REGISTRY=$(PsQuote $Registry); if (-not `$env:TRPG_LOCAL_SERVER_HOME) { `$env:TRPG_LOCAL_SERVER_HOME=$(PsQuote $LocalServerHome) }; "
if ($PinnedReleaseTag) { $updatePrefix += "`$env:TRPG_RELEASE_TAG=$(PsQuote $PinnedReleaseTag); " }
$updateInner = if ($Used) {
  "$updatePrefix`$env:TRPG_ORIGIN=$(PsQuote $Used); irm $(PsQuote $updInstaller) | iex"
} else {
  "$updatePrefix Remove-Item Env:TRPG_ORIGIN -ErrorAction SilentlyContinue; irm $(PsQuote $updInstaller) | iex"
}
$cmd = "@echo off`r`nset `"_LW_CLIENT_VERSION_WAS_SET=0`"`r`nset `"_LW_RELEASE_VERSION_WAS_SET=0`"`r`nset `"_LW_SERVER_RELEASE_TAG_WAS_SET=0`"`r`n"
$cmd += "if defined TRPG_CLIENT_VERSION set `"_LW_CLIENT_VERSION_WAS_SET=1`"`r`n"
$cmd += "if defined TRPG_RELEASE_VERSION set `"_LW_RELEASE_VERSION_WAS_SET=1`"`r`n"
$cmd += "if defined TRPG_SERVER_RELEASE_TAG set `"_LW_SERVER_RELEASE_TAG_WAS_SET=1`"`r`n"
$cmd += "set `"TRPG_HOME=$(CmdEscape $Home_)`"`r`nset `"TRPG_BIN=$(CmdEscape $BinDir)`"`r`nset `"TRPG_REGISTRY=$(CmdEscape $Registry)`"`r`n"
$cmd += "if not defined TRPG_CLIENT_VERSION set `"TRPG_CLIENT_VERSION=$(CmdEscape $ClientVersion)`"`r`n"
$cmd += "if not defined TRPG_RELEASE_VERSION set `"TRPG_RELEASE_VERSION=$(CmdEscape $ClientVersion)`"`r`n"
$cmd += "if not defined TRPG_SERVER_RELEASE_TAG set `"TRPG_SERVER_RELEASE_TAG=$(CmdEscape $ServerReleaseTag)`"`r`n"
$cmd += "if not defined TRPG_LOCAL_SERVER_HOME set `"TRPG_LOCAL_SERVER_HOME=$(CmdEscape $LocalServerHome)`"`r`n"
if ($PinnedReleaseTag) { $cmd += "if not defined TRPG_RELEASE_TAG set `"TRPG_RELEASE_TAG=$(CmdEscape $PinnedReleaseTag)`"`r`n" }
$cmd += "if /I `"%1`"==`"update`" (`r`n"
$cmd += "  if `"%_LW_CLIENT_VERSION_WAS_SET%`"==`"0`" set `"TRPG_CLIENT_VERSION=`"`r`n"
$cmd += "  if `"%_LW_RELEASE_VERSION_WAS_SET%`"==`"0`" set `"TRPG_RELEASE_VERSION=`"`r`n"
$cmd += "  if `"%_LW_SERVER_RELEASE_TAG_WAS_SET%`"==`"0`" set `"TRPG_SERVER_RELEASE_TAG=`"`r`n"
$cmd += "  powershell -NoProfile -Command `"$(CmdEscape $updateInner)`"`r`n  exit /b`r`n)`r`n"
$cmd += "bun run `"$(CmdEscape $entry)`" %*"
$LauncherStage = Join-Path $BinDir (".loreweaver.install-" + [guid]::NewGuid().ToString("N") + ".cmd")
[IO.File]::WriteAllText($LauncherStage, $cmd, [Text.Encoding]::Default)

# Commit only after the archive, dependencies, and launcher are ready. The old
# client remains in the staging tree until both final moves have succeeded.
$TargetClients = Join-Path $Home_ "clients"
$PreviousClients = Join-Path $StagingRoot "previous-clients"
$HadPreviousClient = Test-Path $TargetClients
$PreviousClientStaged = $false
$NewClientCommitted = $false
if ($HadPreviousClient) {
  $PreserveStaging = $true
  Move-Item $TargetClients $PreviousClients
  $PreviousClientStaged = $true
}
try {
  Move-Item $StagedClients $TargetClients
  $NewClientCommitted = $true
  Move-Item $LauncherStage (Join-Path $BinDir "loreweaver.cmd") -Force
  $LauncherStage = ""
}
catch {
  $commitError = $_
  if ($NewClientCommitted) { Remove-Item $TargetClients -Recurse -Force -ErrorAction SilentlyContinue }
  if ($PreviousClientStaged) {
    try { Move-Item $PreviousClients $TargetClients }
    catch {
      $PreserveStaging = $true
      throw "install failed and the previous client could not be restored; backup retained at $PreviousClients"
    }
    $PreviousClientStaged = $false
  }
  $PreserveStaging = $false
  throw $commitError
}
if ($PreviousClientStaged) { Remove-Item $PreviousClients -Recurse -Force -ErrorAction SilentlyContinue }
$PreserveStaging = $false
}
finally {
  if ($LauncherStage) { Remove-Item $LauncherStage -Force -ErrorAction SilentlyContinue }
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  if (-not $PreserveStaging) { Remove-Item $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

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
