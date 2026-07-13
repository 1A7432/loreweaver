#!/usr/bin/env bash
# Loreweaver terminal client — one-line installer (macOS / Linux).
#
#   curl -fsSL https://github.com/1A7432/loreweaver/releases/latest/download/install.sh | bash
#
# It: (1) makes sure `bun` is on PATH (bun is both the runtime AND the package
# manager that auto-resolves the right @opentui/core native core per platform),
# (2) downloads the client tarball — GitHub Release by default, AUTO-FALLING-BACK to the
# 1a7432.site mirror if GitHub is unreachable, (3) `bun install`s it via the official npm
# registry by default, (4) drops a `loreweaver` launcher. Nothing needs root.
#
# Force a source with TRPG_ORIGIN (e.g. TRPG_ORIGIN=https://1a7432.site/trpg to prefer the
# China mirror and skip the GitHub attempt). Pin or roll back a release with
# TRPG_RELEASE_TAG=release-... . Mirrors expose immutable assets under `releases/<tag>/`.
# A release installer's embedded SHA-256 is used only for its own embedded tag; every
# other target is verified against that target archive's adjacent `.sha256`. Also: TRPG_HOME,
# TRPG_REGISTRY, TRPG_BIN, TRPG_LOCAL_SERVER_HOME.
set -euo pipefail

TRPG_EMBEDDED_RELEASE_TAG=""
TRPG_EMBEDDED_CLIENT_VERSION=""
TRPG_EMBEDDED_CLIENT_SHA256=""

version_from_release_tag() {
  case "$1" in
    release-*) printf '%s' "${1#release-}" ;;
    v[0-9]*) printf '%s' "${1#v}" ;;
    *) printf '' ;;
  esac
}

TRPG_HOME="${TRPG_HOME:-$HOME/.loreweaver}"
TRPG_REGISTRY="${TRPG_REGISTRY:-https://registry.npmjs.org}"
TRPG_BIN="${TRPG_BIN:-$HOME/.local/bin}"
TRPG_LOCAL_SERVER_HOME="${TRPG_LOCAL_SERVER_HOME:-$TRPG_HOME}"
TRPG_PINNED_RELEASE_TAG="${TRPG_RELEASE_TAG:-}"
TRPG_INSTALL_RELEASE_TAG="${TRPG_PINNED_RELEASE_TAG:-${TRPG_EMBEDDED_RELEASE_TAG:-latest}}"
TRPG_DERIVED_RELEASE_VERSION="$(version_from_release_tag "$TRPG_INSTALL_RELEASE_TAG")"
TRPG_CLIENT_VERSION="${TRPG_CLIENT_VERSION:-${TRPG_RELEASE_VERSION:-${TRPG_DERIVED_RELEASE_VERSION:-$TRPG_EMBEDDED_CLIENT_VERSION}}}"
TRPG_SERVER_RELEASE_TAG="${TRPG_SERVER_RELEASE_TAG:-$TRPG_INSTALL_RELEASE_TAG}"

# Distribution: default GitHub Release; TRPG_ORIGIN overrides the primary source. When the
# primary is unavailable (e.g. GitHub from mainland China) we auto-fall-back to the mirror.
# Concrete tags use an immutable `releases/<tag>/` path on HTTP mirrors; only the literal
# `latest` target uses a mirror's flat compatibility path.
MIRROR="https://1a7432.site/trpg"
PRIMARY="${TRPG_ORIGIN:-}"                        # empty => GitHub
release_base_of() {
  if [ -n "$1" ]; then
    if [ "$TRPG_INSTALL_RELEASE_TAG" = "latest" ]; then
      printf '%s' "${1%/}"
    else
      printf '%s/releases/%s' "${1%/}" "$TRPG_INSTALL_RELEASE_TAG"
    fi
  elif [ "$TRPG_INSTALL_RELEASE_TAG" = "latest" ]; then
    printf 'https://github.com/1A7432/loreweaver/releases/latest/download'
  else
    printf 'https://github.com/1A7432/loreweaver/releases/download/%s' "$TRPG_INSTALL_RELEASE_TAG"
  fi
}
tarball_of() { printf '%s/loreweaver-client.tar.gz' "$(release_base_of "$1")"; }
installer_of() {
  if [ -n "$1" ]; then
    # An embedded release tag identifies the payload this installer verifies; it is
    # not an operator pin. Keep `loreweaver update` following the mirror's flat/latest
    # installer unless TRPG_RELEASE_TAG was explicitly supplied.
    if [ -n "$TRPG_PINNED_RELEASE_TAG" ]; then
      printf '%s/releases/%s/install.sh' "${1%/}" "$TRPG_INSTALL_RELEASE_TAG"
    else
      printf '%s/install.sh' "${1%/}"
    fi
  elif [ -n "$TRPG_PINNED_RELEASE_TAG" ]; then
    printf 'https://github.com/1A7432/loreweaver/releases/download/%s/install.sh' "$TRPG_INSTALL_RELEASE_TAG"
  else
    printf 'https://github.com/1A7432/loreweaver/releases/latest/download/install.sh'
  fi
}
desc_of()      { [ -n "$1" ] && printf '%s' "$1" || printf 'GitHub Release'; }

say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
shell_quote() { printf '%q' "$1"; }

case "$TRPG_INSTALL_RELEASE_TAG" in
  latest) ;;
  ""|*[!A-Za-z0-9._+-]*) die "TRPG_RELEASE_TAG contains characters that are unsafe in a release URL" ;;
  *) ;;
esac
if [ -n "$PRIMARY" ]; then
  case "$PRIMARY" in http://*|https://*) ;; *) die "TRPG_ORIGIN must be an http(s) URL" ;; esac
  case "$PRIMARY" in *$'\r'*|*$'\n'*) die "TRPG_ORIGIN must not contain newlines" ;; esac
  PRIMARY_AUTHORITY="${PRIMARY#*://}"; PRIMARY_AUTHORITY="${PRIMARY_AUTHORITY%%/*}"
  case "$PRIMARY_AUTHORITY" in *@*) die "TRPG_ORIGIN must not contain embedded credentials" ;; esac
fi
case "$TRPG_REGISTRY" in http://*|https://*) ;; *) die "TRPG_REGISTRY must be an http(s) URL" ;; esac
case "$TRPG_REGISTRY" in *$'\r'*|*$'\n'*) die "TRPG_REGISTRY must not contain newlines" ;; esac
REGISTRY_AUTHORITY="${TRPG_REGISTRY#*://}"; REGISTRY_AUTHORITY="${REGISTRY_AUTHORITY%%/*}"
case "$REGISTRY_AUTHORITY" in *@*) die "TRPG_REGISTRY must not contain embedded credentials" ;; esac

# curl OR wget — fresh Linux images often ship only one of them.
if command -v curl >/dev/null 2>&1; then
  dl()      { curl -fsSL --connect-timeout 15 "$1" -o "$2"; }
  dl_pipe() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl()      { wget -q --timeout=15 -O "$2" "$1"; }
  dl_pipe() { wget -qO- "$1"; }
else
  die "need curl or wget"
fi
command -v tar  >/dev/null 2>&1 || die "need tar"
if ! command -v sha256sum >/dev/null 2>&1 \
  && ! command -v shasum >/dev/null 2>&1 \
  && ! command -v openssl >/dev/null 2>&1; then
  die "need sha256sum, shasum, or openssl to verify the client download"
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

expected_sha256() {  # $1 = tarball URL; $2 = target tag
  if [ -n "$TRPG_EMBEDDED_CLIENT_SHA256" ] \
    && [ -n "$TRPG_EMBEDDED_RELEASE_TAG" ] \
    && [ "$2" = "$TRPG_EMBEDDED_RELEASE_TAG" ]; then
    printf '%s' "$TRPG_EMBEDDED_CLIENT_SHA256"
    return
  fi
  local sidecar
  sidecar="$(mktemp)"
  if ! dl "$1.sha256" "$sidecar"; then
    rm -f "$sidecar"
    return 1
  fi
  awk 'NR == 1 {print $1}' "$sidecar"
  rm -f "$sidecar"
}

verify_sha256() {  # $1 = file; $2 = expected digest
  local expected actual
  expected="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
  [ "${#expected}" -eq 64 ] || return 1
  case "$expected" in *[!0-9a-f]*) return 1 ;; esac
  actual="$(sha256_of "$1" | tr 'A-F' 'a-f')"
  [ "$actual" = "$expected" ]
}

rewrite_lock_registry() {  # $1 = staged clients directory
  # bun.lock records absolute package URLs, so .npmrc/--registry alone does not
  # redirect an archive produced against another registry. Rewrite only the
  # installed copy (never the release payload) before dependency resolution.
  local lock="$1/bun.lock"
  [ -f "$lock" ] || return 0
  TRPG_LOCK_FILE="$lock" TRPG_LOCK_REGISTRY="$TRPG_REGISTRY" bun -e '
    const path = process.env.TRPG_LOCK_FILE;
    let registry;
    try {
      const url = new URL(process.env.TRPG_LOCK_REGISTRY || "");
      if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) process.exit(2);
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
}

# 1) bun — the runtime + package manager the client is built on.
if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  say "installing bun (runtime + package manager)…"
  dl_pipe https://bun.sh/install | bash >/dev/null \
    || die "bun install failed. If GitHub is slow where you are, install bun manually (https://bun.sh) then re-run."
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || die "bun still not on PATH — open a new shell and re-run."
say "bun $(bun --version) ready"

mkdir -p "$TRPG_HOME"
INSTALL_STAGING="$(mktemp -d "$TRPG_HOME/.client-install.XXXXXX")" \
  || die "could not create a client staging directory"
CLIENT_STAGE="$INSTALL_STAGING/payload"
LAUNCHER_STAGE=""
cleanup_install() {
  [ -z "${LAUNCHER_STAGE:-}" ] || rm -f "$LAUNCHER_STAGE"
  [ -z "${INSTALL_STAGING:-}" ] || rm -rf "$INSTALL_STAGING"
}
trap cleanup_install EXIT
trap 'exit 130' HUP INT TERM

archive_is_safe() {  # $1 = verified client tarball
  local archive="$1" listing verbose entry normalized first seen=0
  listing="$(mktemp)"
  verbose="$(mktemp)"
  if ! LC_ALL=C tar tzf "$archive" > "$listing" 2>/dev/null \
    || ! LC_ALL=C tar tvzf "$archive" > "$verbose" 2>/dev/null; then
    rm -f "$listing" "$verbose"
    return 1
  fi
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    normalized="${entry//\\//}"
    while [ "${normalized#./}" != "$normalized" ]; do normalized="${normalized#./}"; done
    case "$normalized" in
      ""|/*|//*|[A-Za-z]:*) rm -f "$listing" "$verbose"; return 1 ;;
    esac
    case "/$normalized/" in *"/../"*) rm -f "$listing" "$verbose"; return 1 ;; esac
    case "$normalized" in
      clients|clients/*) ;;
      *) rm -f "$listing" "$verbose"; return 1 ;;
    esac
    seen=1
  done < "$listing"
  [ "$seen" -eq 1 ] || { rm -f "$listing" "$verbose"; return 1; }
  # The official client payload contains only files/directories. Reject links,
  # devices, and other special entries so extraction cannot pivot through a
  # symlink even when all path names themselves look relative.
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    first="${entry%"${entry#?}"}"
    case "$first" in -|d) ;; *) rm -f "$listing" "$verbose"; return 1 ;; esac
  done < "$verbose"
  rm -f "$listing" "$verbose"
  return 0
}

# 2) Client tarball. Only source availability failures may fall back. Invalid checksum
# metadata, a digest mismatch, or an extraction failure is fatal and never tries another
# payload under the same trust decision. Return 10=unavailable, 20=fatal.
fetch_client() {  # $1 = tarball URL; $2 = target tag; $3 = extraction root
  local tmp expected destination="$3"
  rm -rf "$destination"
  mkdir -p "$destination"
  tmp="$(mktemp)"
  if ! dl "$1" "$tmp"; then
    rm -f "$tmp"
    return 10
  fi
  if ! expected="$(expected_sha256 "$1" "$2")"; then
    rm -f "$tmp"
    printf '\033[1;31m\u2717 could not download the SHA-256 sidecar for %s\033[0m\n' "$1" >&2
    return 10
  fi
  if ! verify_sha256 "$tmp" "$expected"; then
    rm -f "$tmp"
    printf '\033[1;31m\u2717 client archive SHA-256 mismatch or invalid metadata; refusing to install\033[0m\n' >&2
    return 20
  fi
  if ! archive_is_safe "$tmp"; then
    rm -f "$tmp"
    printf '\033[1;31m\u2717 verified client archive contains an unsafe path or entry type\033[0m\n' >&2
    return 20
  fi
  if ! tar xzf "$tmp" -C "$destination" 2>/dev/null; then
    rm -f "$tmp"
    printf '\033[1;31m\u2717 extracting the verified client archive failed\033[0m\n' >&2
    return 20
  fi
  rm -f "$tmp"
  if [ ! -f "$destination/clients/package.json" ] \
    || [ ! -f "$destination/clients/bun.lock" ] \
    || [ ! -f "$destination/clients/tui/src/index.tsx" ]; then
    printf '\033[1;31m\u2717 verified client archive has an unexpected layout\033[0m\n' >&2
    return 20
  fi
  return 0
}
USED="$PRIMARY"
say "downloading client from $(desc_of "$PRIMARY")…"
if fetch_client "$(tarball_of "$PRIMARY")" "$TRPG_INSTALL_RELEASE_TAG" "$CLIENT_STAGE"; then
  :
else
  primary_status=$?
  if [ "$primary_status" -eq 10 ] && [ "$PRIMARY" != "$MIRROR" ]; then
    say "primary source unavailable — falling back to the 1a7432.site mirror…"
    if fetch_client "$(tarball_of "$MIRROR")" "$TRPG_INSTALL_RELEASE_TAG" "$CLIENT_STAGE"; then
      USED="$MIRROR"
    else
      mirror_status=$?
      if [ "$mirror_status" -eq 10 ]; then
        die "could not fetch the client or its checksum from GitHub or the mirror — check your network / proxy."
      fi
      die "the mirrored client failed integrity or extraction checks; refusing to install."
    fi
  elif [ "$primary_status" -eq 10 ]; then
    die "could not fetch the client or its checksum from the mirror — check your network."
  else
    die "the client failed integrity or extraction checks; refusing to install."
  fi
fi

# 3) deps — bun install resolves the per-platform @opentui/core native core for us.
say "installing dependencies (registry: ${TRPG_REGISTRY})…"
STAGED_CLIENTS="$CLIENT_STAGE/clients"
printf 'registry=%s\n' "$TRPG_REGISTRY" > "$STAGED_CLIENTS/.npmrc"
rewrite_lock_registry "$STAGED_CLIENTS" \
  || die "could not apply TRPG_REGISTRY to the client lockfile."
( cd "$STAGED_CLIENTS" && bun install --silent ) \
  || die "bun install failed. Try again, or set TRPG_REGISTRY to another mirror."

# 4) launcher — `loreweaver` (matches the project name). `loreweaver update` re-runs
#    this installer to fetch + reinstall the latest client; anything else launches the TUI.
mkdir -p "$TRPG_BIN"
[ ! -d "$TRPG_BIN/loreweaver" ] || die "$TRPG_BIN/loreweaver is a directory; cannot install the launcher"
UPDATE_INSTALLER="$(installer_of "$USED")"   # re-update from whichever source actually worked
Q_TRPG_HOME="$(shell_quote "$TRPG_HOME")"
Q_TRPG_BIN="$(shell_quote "$TRPG_BIN")"
Q_TRPG_REGISTRY="$(shell_quote "$TRPG_REGISTRY")"
Q_TRPG_LOCAL_SERVER_HOME="$(shell_quote "$TRPG_LOCAL_SERVER_HOME")"
Q_TRPG_CLIENT_VERSION="$(shell_quote "$TRPG_CLIENT_VERSION")"
Q_TRPG_SERVER_RELEASE_TAG="$(shell_quote "$TRPG_SERVER_RELEASE_TAG")"
Q_UPDATE_INSTALLER="$(shell_quote "$UPDATE_INSTALLER")"
PINNED_RELEASE_EXPORT=""
if [ -n "$TRPG_PINNED_RELEASE_TAG" ]; then
  Q_TRPG_PINNED_RELEASE_TAG="$(shell_quote "$TRPG_PINNED_RELEASE_TAG")"
  PINNED_RELEASE_EXPORT="export TRPG_RELEASE_TAG=$Q_TRPG_PINNED_RELEASE_TAG"
fi
if [ -n "$USED" ]; then
  Q_USED="$(shell_quote "$USED")"
  UPDATE_ORIGIN_COMMAND="export TRPG_ORIGIN=$Q_USED"
else
  UPDATE_ORIGIN_COMMAND="unset TRPG_ORIGIN"
fi
LAUNCHER_STAGE="$(mktemp "$TRPG_BIN/.loreweaver.install.XXXXXX")" \
  || die "could not create a launcher staging file"
cat > "$LAUNCHER_STAGE" <<EOF
#!/usr/bin/env bash
set -o pipefail
_LW_CLIENT_VERSION_WAS_SET=0
_LW_RELEASE_VERSION_WAS_SET=0
_LW_SERVER_RELEASE_TAG_WAS_SET=0
[ "\${TRPG_CLIENT_VERSION+x}" = x ] && _LW_CLIENT_VERSION_WAS_SET=1
[ "\${TRPG_RELEASE_VERSION+x}" = x ] && _LW_RELEASE_VERSION_WAS_SET=1
[ "\${TRPG_SERVER_RELEASE_TAG+x}" = x ] && _LW_SERVER_RELEASE_TAG_WAS_SET=1
export TRPG_HOME=$Q_TRPG_HOME
export TRPG_BIN=$Q_TRPG_BIN
export TRPG_REGISTRY=$Q_TRPG_REGISTRY
[ "\$_LW_CLIENT_VERSION_WAS_SET" -eq 1 ] || export TRPG_CLIENT_VERSION=$Q_TRPG_CLIENT_VERSION
[ "\$_LW_RELEASE_VERSION_WAS_SET" -eq 1 ] || export TRPG_RELEASE_VERSION=$Q_TRPG_CLIENT_VERSION
[ "\$_LW_SERVER_RELEASE_TAG_WAS_SET" -eq 1 ] || export TRPG_SERVER_RELEASE_TAG=$Q_TRPG_SERVER_RELEASE_TAG
$PINNED_RELEASE_EXPORT
if [ -z "\${TRPG_LOCAL_SERVER_HOME:-}" ]; then
  export TRPG_LOCAL_SERVER_HOME=$Q_TRPG_LOCAL_SERVER_HOME
else
  export TRPG_LOCAL_SERVER_HOME
fi
if [ "\${1:-}" = "update" ]; then
  echo "updating Loreweaver…"
  [ "\$_LW_CLIENT_VERSION_WAS_SET" -eq 1 ] || unset TRPG_CLIENT_VERSION
  [ "\$_LW_RELEASE_VERSION_WAS_SET" -eq 1 ] || unset TRPG_RELEASE_VERSION
  [ "\$_LW_SERVER_RELEASE_TAG_WAS_SET" -eq 1 ] || unset TRPG_SERVER_RELEASE_TAG
  $UPDATE_ORIGIN_COMMAND
  UPDATE_INSTALLER=$Q_UPDATE_INSTALLER
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "\$UPDATE_INSTALLER" | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "\$UPDATE_INSTALLER" | bash
  else
    echo "need curl or wget to update Loreweaver" >&2
    exit 1
  fi
  exit \$?
fi
exec bun run "\${TRPG_HOME}/clients/tui/src/index.tsx" "\$@"
EOF
chmod +x "$LAUNCHER_STAGE"

# Commit only after verification, extraction, dependency installation, and
# launcher generation have all succeeded. Keep the old client inside the same
# staging tree until the launcher rename finishes, so either version remains runnable.
CLIENT_BACKUP="$INSTALL_STAGING/previous-clients"
HAD_PREVIOUS_CLIENT=0
if [ -e "$TRPG_HOME/clients" ] || [ -L "$TRPG_HOME/clients" ]; then
  mv "$TRPG_HOME/clients" "$CLIENT_BACKUP" \
    || die "could not stage the previous client for upgrade"
  HAD_PREVIOUS_CLIENT=1
fi
if ! mv "$STAGED_CLIENTS" "$TRPG_HOME/clients"; then
  if [ "$HAD_PREVIOUS_CLIENT" -eq 1 ] && ! mv "$CLIENT_BACKUP" "$TRPG_HOME/clients"; then
    INSTALL_STAGING=""
    die "install failed and the previous client could not be restored; backup retained at $CLIENT_BACKUP"
  fi
  die "could not commit the verified client; the previous client was restored"
fi
if ! mv -f "$LAUNCHER_STAGE" "$TRPG_BIN/loreweaver"; then
  rm -rf "$TRPG_HOME/clients"
  if [ "$HAD_PREVIOUS_CLIENT" -eq 1 ] && ! mv "$CLIENT_BACKUP" "$TRPG_HOME/clients"; then
    INSTALL_STAGING=""
    die "launcher install failed and the previous client could not be restored; backup retained at $CLIENT_BACKUP"
  fi
  die "could not commit the launcher; the previous client was restored"
fi
LAUNCHER_STAGE=""
rm -rf "$CLIENT_BACKUP"

echo
say "installed ✓"
echo "  Launcher: $TRPG_BIN/loreweaver"
echo "  Local server folder: $TRPG_LOCAL_SERVER_HOME"
case ":$PATH:" in
  *":$TRPG_BIN:"*) echo "  Run:      loreweaver          (update later with: loreweaver update)" ;;
  *) echo "  '$TRPG_BIN' is not on your PATH yet. Either add it, or run the full path:"
     echo "            $TRPG_BIN/loreweaver" ;;
esac
echo
echo "  In the connect screen, use:"
echo "    ticket  <the p2p ticket your Keeper shared>   (or click 'Host locally & play' to run your own)"
echo "    key     <the invite key your Keeper gave you>"
echo "    name    <your nickname>"
