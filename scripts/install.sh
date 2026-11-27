#!/usr/bin/env bash
# Loreweaver 3 — installer for macOS and Linux.
#
#   curl -fsSL https://github.com/1A7432/loreweaver/releases/latest/download/install.sh | bash
#
# It downloads this machine's archive of a release, checks it against the release's
# SHA256SUMS, and puts the two programs the archive holds — `loreweaver` (the server) and
# `loreweaver-tui` (the terminal client) — into $TRPG_HOME/bin, then links both into
# $TRPG_BIN. Nothing needs root and nothing else is installed: each program is one file.
# Running it again replaces them with the release asked for.
#
#   TRPG_RELEASE_TAG   a release's tag (v3.0.0) instead of the latest release
#   TRPG_ORIGIN        another place holding the release's files: an https:// URL of a
#                      folder, or a folder on this machine
#   TRPG_HOME          default ~/.loreweaver
#   TRPG_BIN           where the two commands are linked; default ~/.local/bin
#   TRPG_UPGRADE_TO_3  on a machine that has Loreweaver 2: 1 installs without asking
#
# Loreweaver 3 is not an update of Loreweaver 2 (neither opens the other's rooms, saves or
# packs, and the two do not connect), and Loreweaver 2's own `loreweaver update` runs this
# script. So on a machine that has Loreweaver 2 and not yet 3 it says so and asks first; with
# no terminal to ask on it installs nothing. Loreweaver 2 is never removed.
#
# The whole script is one function called on its last line, so a download cut short runs nothing.
set -euo pipefail

REPOSITORY="1A7432/loreweaver"
PROGRAMS="loreweaver loreweaver-tui"
# The last Loreweaver 2 release that holds its own installer.
LAST_V2_TAG="v2.6.0"

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="macos" ;;
    Linux) os="linux" ;;
    *) die "no Loreweaver build for $(uname -s); on Windows use install.ps1" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) die "no Loreweaver build for a $(uname -m) processor" ;;
  esac
  [ "$os-$arch" != "macos-x64" ] || die "no Loreweaver build for Intel Macs: run it from a checkout with Bun (see the README)"
  if [ "$os" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
    die "no Loreweaver build for musl Linux (Alpine): run it from a checkout with Bun (see the README)"
  fi
  printf '%s-%s' "$os" "$arch"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else die "need sha256sum, shasum or openssl to check the download"
  fi
}

# fetch <file name> <destination>: from the release, or from TRPG_ORIGIN.
fetch() {
  local name="$1" to="$2" origin="${TRPG_ORIGIN:-}" base
  case "$origin" in
    "")
      if [ "$TAG" = "latest" ]; then base="https://github.com/$REPOSITORY/releases/latest/download"
      else base="https://github.com/$REPOSITORY/releases/download/$TAG"
      fi ;;
    https://*) base="${origin%/}" ;;
    http://*) die "TRPG_ORIGIN must be https:// or a folder: a plain http download can be replaced on the way" ;;
    *)
      [ -f "${origin%/}/$name" ] || die "$name is not in ${origin%/}"
      cp "${origin%/}/$name" "$to"
      return ;;
  esac
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --connect-timeout 20 "$base/$name" -o "$to" || die "could not download $base/$name"
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only --timeout=20 -O "$to" "$base/$name" || die "could not download $base/$name"
  else die "need curl or wget"
  fi
}

# has_loreweaver_2 <home> <links>: Loreweaver 2 is installed here (its client's files, or its
# launcher) and Loreweaver 3 is not yet.
has_loreweaver_2() {
  [ ! -e "$1/bin/loreweaver" ] || return 1
  [ -f "$1/clients/tui/src/index.tsx" ] && return 0
  [ -f "$2/loreweaver" ] && [ ! -L "$2/loreweaver" ] && grep -q 'clients/tui/src/index.tsx' "$2/loreweaver" 2>/dev/null
}

# confirm_upgrade <links>: say what installing over Loreweaver 2 means and ask. Returns to
# install; exits otherwise (0 when the person said no, 1 when nobody could be asked).
confirm_upgrade() {
  local answer=""
  say "Loreweaver 2 is installed on this machine. Loreweaver 3 is a new program, not an update of it:"
  say "  - it does not open Loreweaver 2's rooms, saves, packs or modules, and a 2 client and a 3 server"
  say "    (or the other way round) do not connect;"
  say "  - Loreweaver 2 is kept: its command becomes $1/loreweaver.old, its files and data are not touched;"
  say "  - to put Loreweaver 2's command back, or reinstall it:"
  say "      curl -fsSL https://github.com/$REPOSITORY/releases/download/$LAST_V2_TAG/install.sh | bash"
  case "${TRPG_UPGRADE_TO_3:-}" in
    1|y|Y|yes|true) return 0 ;;
    "") ;;
    *) say "nothing was installed (TRPG_UPGRADE_TO_3=${TRPG_UPGRADE_TO_3}). Loreweaver 2 is as it was."; exit 0 ;;
  esac
  # This script usually arrives on standard input (curl | bash): the answer comes from the terminal.
  if ! ( : </dev/tty >/dev/tty ) 2>/dev/null; then
    die "nothing was installed: there is no terminal to ask on. To install Loreweaver 3 here, run this again with TRPG_UPGRADE_TO_3=1"
  fi
  printf '▸ Install Loreweaver 3 now? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    y|Y|yes|Yes|YES) return 0 ;;
  esac
  say "nothing was installed. Loreweaver 2 is as it was."
  exit 0
}

install_loreweaver() {
  command -v tar >/dev/null 2>&1 || die "need tar"
  TAG="${TRPG_RELEASE_TAG:-latest}"
  case "$TAG" in
    ""|*[!A-Za-z0-9._+-]*) die "TRPG_RELEASE_TAG is not a release tag" ;;
    # A Loreweaver 2 tag (a pin its launcher passes on): that release has its own installer.
    v[012].*|release-[012].*) die "$TAG is a Loreweaver 2 release, and this is the Loreweaver 3 installer. Use that release's own:  curl -fsSL https://github.com/$REPOSITORY/releases/download/$TAG/install.sh | bash" ;;
  esac
  local home="${TRPG_HOME:-$HOME/.loreweaver}" links="${TRPG_BIN:-$HOME/.local/bin}"
  local target archive stage expected actual program
  target="$(platform)"
  archive="loreweaver-$target.tar.gz"
  if has_loreweaver_2 "$home" "$links"; then confirm_upgrade "$links"; fi

  mkdir -p "$home/bin"
  stage="$(mktemp -d "$home/.install.XXXXXX")" || die "could not create a folder under $home"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" EXIT

  say "downloading $archive ($TAG)"
  fetch SHA256SUMS "$stage/SHA256SUMS"
  fetch "$archive" "$stage/$archive"
  expected="$(awk -v name="$archive" '$2 == name || $2 == "*" name {print $1}' "$stage/SHA256SUMS" | tr 'A-F' 'a-f')"
  case "$expected" in
    "") die "SHA256SUMS does not list $archive" ;;
    *[!0-9a-f]*) die "SHA256SUMS does not hold a SHA-256 for $archive" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "SHA256SUMS does not hold a SHA-256 for $archive"
  actual="$(sha256_of "$stage/$archive" | tr 'A-F' 'a-f')"
  [ "$actual" = "$expected" ] || die "$archive does not match its checksum: nothing was installed"

  mkdir "$stage/unpacked"
  tar -xzf "$stage/$archive" -C "$stage/unpacked" --strip-components=1
  for program in $PROGRAMS; do
    [ -f "$stage/unpacked/$program" ] || die "$archive holds no $program: nothing was installed"
    chmod 755 "$stage/unpacked/$program"
  done
  # A build that cannot start here is not installed over one that can.
  "$stage/unpacked/loreweaver" --version >/dev/null 2>&1 || die "the downloaded server does not run on this machine: nothing was installed"

  # Same folder, same disk: each rename replaces a program whole or not at all.
  for program in $PROGRAMS; do mv -f "$stage/unpacked/$program" "$home/bin/$program"; done

  mkdir -p "$links"
  for program in $PROGRAMS; do
    if [ -e "$links/$program" ] && [ ! -L "$links/$program" ]; then
      # Something of that name that is not a link of ours (the 2.x launcher was `loreweaver`).
      mv -f "$links/$program" "$links/$program.old"
      say "$links/$program was kept as $program.old"
    fi
    ln -sf "$home/bin/$program" "$links/$program"
  done

  say "installed Loreweaver $("$home/bin/loreweaver" --version) in $home/bin"
  say "  loreweaver-tui   the terminal client: connect to a table, or host one on this machine"
  say "  loreweaver       the server: loreweaver serve"
  case ":$PATH:" in
    *":$links:"*) ;;
    *) say "$links is not on your PATH. Add it:  export PATH=\"$links:\$PATH\"" ;;
  esac
}

install_loreweaver
