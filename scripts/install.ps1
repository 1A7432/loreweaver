# Loreweaver 3 — installer for Windows.
#
#   irm https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1 | iex
#
# It downloads the Windows archive of a release, checks it against the release's SHA256SUMS,
# and puts the two programs the archive holds — loreweaver.exe (the server) and
# loreweaver-tui.exe (the terminal client) — into %TRPG_BIN%, which it adds to your own PATH.
# Nothing needs an administrator and nothing else is installed: each program is one file.
# Running it again replaces them with the release asked for.
#
#   TRPG_RELEASE_TAG       a release's tag (v3.0.0) instead of the latest release
#   TRPG_ORIGIN            another place holding the release's files: an https:// URL of a
#                          folder, or a folder on this machine
#   TRPG_HOME              default %USERPROFILE%\.loreweaver
#   TRPG_BIN               default %TRPG_HOME%\bin
#   TRPG_NO_MODIFY_PATH    set to leave PATH alone
#
# The whole script is one function called on its last line, so a download cut short runs nothing.

function Install-Loreweaver {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  $Repository = "1A7432/loreweaver"
  $Programs = @("loreweaver.exe", "loreweaver-tui.exe")
  # The one Windows build is x64; Windows on ARM runs it emulated.
  $Archive = "loreweaver-windows-x64.zip"

  $Tag = if ($env:TRPG_RELEASE_TAG) { $env:TRPG_RELEASE_TAG } else { "latest" }
  if ($Tag -notmatch '^[A-Za-z0-9._+-]+$') { throw "TRPG_RELEASE_TAG is not a release tag" }
  $LwHome = if ($env:TRPG_HOME) { $env:TRPG_HOME } else { Join-Path $HOME ".loreweaver" }
  $Bin = if ($env:TRPG_BIN) { $env:TRPG_BIN } else { Join-Path $LwHome "bin" }
  $Origin = $env:TRPG_ORIGIN

  function Fetch([string]$Name, [string]$To) {
    if (-not $Origin) {
      $base = if ($Tag -eq "latest") { "https://github.com/$Repository/releases/latest/download" } else { "https://github.com/$Repository/releases/download/$Tag" }
    } elseif ($Origin -match '^https://') {
      $base = $Origin.TrimEnd('/')
    } elseif ($Origin -match '^http://') {
      throw "TRPG_ORIGIN must be https:// or a folder: a plain http download can be replaced on the way"
    } else {
      $from = Join-Path $Origin $Name
      if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "$Name is not in $Origin" }
      Copy-Item -LiteralPath $from -Destination $To
      return
    }
    try {
      Invoke-WebRequest -Uri "$base/$Name" -OutFile $To -UseBasicParsing
    } catch {
      throw "could not download $base/$Name"
    }
  }

  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  New-Item -ItemType Directory -Force -Path $LwHome | Out-Null
  $Stage = Join-Path $LwHome (".install." + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $Stage | Out-Null
  try {
    Write-Host "> downloading $Archive ($Tag)"
    $sums = Join-Path $Stage "SHA256SUMS"
    $zip = Join-Path $Stage $Archive
    Fetch "SHA256SUMS" $sums
    Fetch $Archive $zip

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $Archive) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { throw "SHA256SUMS does not list $Archive" }
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS does not hold a SHA-256 for $Archive" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "$Archive does not match its checksum: nothing was installed" }

    $unpacked = Join-Path $Stage "unpacked"
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    # The archive holds one folder; the programs are in it.
    $inner = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
    if (-not $inner) { throw "$Archive holds no folder: nothing was installed" }
    foreach ($program in $Programs) {
      if (-not (Test-Path -LiteralPath (Join-Path $inner.FullName $program) -PathType Leaf)) { throw "$Archive holds no $program`: nothing was installed" }
    }
    # A build that cannot start here is not installed over one that can.
    & (Join-Path $inner.FullName "loreweaver.exe") --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "the downloaded server does not run on this machine: nothing was installed" }

    foreach ($program in $Programs) {
      try {
        Move-Item -LiteralPath (Join-Path $inner.FullName $program) -Destination (Join-Path $Bin $program) -Force
      } catch {
        throw "could not replace $program in $Bin — is Loreweaver running? Close it and run this again."
      }
    }
  } finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  }

  $version = & (Join-Path $Bin "loreweaver.exe") --version
  Write-Host "> installed Loreweaver $version in $Bin"
  Write-Host ">   loreweaver-tui   the terminal client: connect to a table, or host one on this machine"
  Write-Host ">   loreweaver       the server: loreweaver serve"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $onPath = ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Bin.TrimEnd('\') }).Count -gt 0
  if ($onPath) { return }
  if ($env:TRPG_NO_MODIFY_PATH) {
    Write-Host "> $Bin is not on your PATH; add it to run the two commands by name."
    return
  }
  $newPath = if ($userPath) { "$userPath;$Bin" } else { $Bin }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "> added $Bin to your PATH: open a new terminal to use it."
}

Install-Loreweaver
