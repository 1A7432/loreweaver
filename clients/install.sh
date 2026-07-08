#!/usr/bin/env bash
# Loreweaver terminal client — one-line installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash
#
# It: (1) makes sure `bun` is on PATH (bun is both the runtime AND the package
# manager that auto-resolves the right @opentui/core native core per platform),
# (2) downloads the client tarball — GitHub Release by default, AUTO-FALLING-BACK to the
# 1a7432.site mirror if GitHub is unreachable, (3) `bun install`s it via a fast registry
# mirror, (4) drops a `loreweaver` launcher. Nothing needs root.
#
# Force a source with TRPG_ORIGIN (e.g. TRPG_ORIGIN=https://1a7432.site/trpg to prefer the
# China mirror and skip the GitHub attempt). Also: TRPG_HOME, TRPG_REGISTRY, TRPG_BIN,
# TRPG_LOCAL_SERVER_HOME.
set -euo pipefail

TRPG_HOME="${TRPG_HOME:-$HOME/.loreweaver}"
TRPG_REGISTRY="${TRPG_REGISTRY:-https://registry.npmmirror.com}"
TRPG_BIN="${TRPG_BIN:-$HOME/.local/bin}"
TRPG_LOCAL_SERVER_HOME="${TRPG_LOCAL_SERVER_HOME:-$TRPG_HOME}"

# Distribution: default GitHub Release; TRPG_ORIGIN overrides the primary source. When the
# primary is unreachable (e.g. GitHub from mainland China) we auto-fall-back to the mirror.
MIRROR="https://1a7432.site/trpg"
PRIMARY="${TRPG_ORIGIN:-}"                        # empty => GitHub
tarball_of()   { [ -n "$1" ] && printf '%s/loreweaver-client.tar.gz' "$1" || printf 'https://github.com/1A7432/loreweaver/releases/latest/download/loreweaver-client.tar.gz'; }
installer_of() { [ -n "$1" ] && printf '%s/install.sh' "$1" || printf 'https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh'; }
desc_of()      { [ -n "$1" ] && printf '%s' "$1" || printf 'GitHub Release'; }

say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
shell_quote() { printf '%q' "$1"; }

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

# 2) client tarball — try the primary source, auto-fall-back to the 1a7432.site mirror.
fetch_client() {  # $1 = tarball url; downloads to a temp file, extracts only on success
  local tmp; tmp="$(mktemp)"
  if dl "$1" "$tmp" && tar xzf "$tmp" -C "$TRPG_HOME" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  rm -f "$tmp"; return 1
}
rm -rf "$TRPG_HOME/clients"; mkdir -p "$TRPG_HOME"
USED="$PRIMARY"
say "downloading client from $(desc_of "$PRIMARY")…"
if fetch_client "$(tarball_of "$PRIMARY")"; then :
elif [ "$PRIMARY" != "$MIRROR" ]; then
  say "primary source unreachable — falling back to the 1a7432.site mirror…"
  rm -rf "$TRPG_HOME/clients"
  fetch_client "$(tarball_of "$MIRROR")" && USED="$MIRROR" \
    || die "could not fetch the client from GitHub or the mirror — check your network / proxy."
else
  die "could not fetch the client from the mirror — check your network."
fi

# 3) deps — bun install resolves the per-platform @opentui/core native core for us.
say "installing dependencies (registry: ${TRPG_REGISTRY})…"
printf 'registry=%s\n' "$TRPG_REGISTRY" > "$TRPG_HOME/clients/.npmrc"
( cd "$TRPG_HOME/clients" && bun install --silent ) \
  || die "bun install failed. Try again, or set TRPG_REGISTRY to another mirror."

# 4) launcher — `loreweaver` (matches the project name). `loreweaver update` re-runs
#    this installer to fetch + reinstall the latest client; anything else launches the TUI.
mkdir -p "$TRPG_BIN"
UPDATE_INSTALLER="$(installer_of "$USED")"   # re-update from whichever source actually worked
Q_TRPG_HOME="$(shell_quote "$TRPG_HOME")"
Q_TRPG_BIN="$(shell_quote "$TRPG_BIN")"
Q_TRPG_REGISTRY="$(shell_quote "$TRPG_REGISTRY")"
Q_TRPG_LOCAL_SERVER_HOME="$(shell_quote "$TRPG_LOCAL_SERVER_HOME")"
UPDATE_ENV="TRPG_HOME=$Q_TRPG_HOME TRPG_BIN=$Q_TRPG_BIN TRPG_REGISTRY=$Q_TRPG_REGISTRY TRPG_LOCAL_SERVER_HOME=$Q_TRPG_LOCAL_SERVER_HOME"
if [ -n "$USED" ]; then
  Q_USED="$(shell_quote "$USED")"
  UPDATE_ENV="$UPDATE_ENV TRPG_ORIGIN=$Q_USED"
fi
cat > "$TRPG_BIN/loreweaver" <<EOF
#!/usr/bin/env bash
export TRPG_HOME=$Q_TRPG_HOME
export TRPG_BIN=$Q_TRPG_BIN
export TRPG_REGISTRY=$Q_TRPG_REGISTRY
if [ -z "\${TRPG_LOCAL_SERVER_HOME:-}" ]; then
  export TRPG_LOCAL_SERVER_HOME=$Q_TRPG_LOCAL_SERVER_HOME
else
  export TRPG_LOCAL_SERVER_HOME
fi
if [ "\$1" = "update" ]; then
  echo "updating Loreweaver…"
  exec env $UPDATE_ENV bash -c "(command -v curl >/dev/null 2>&1 && curl -fsSL '${UPDATE_INSTALLER}' || wget -qO- '${UPDATE_INSTALLER}') | bash"
fi
exec bun run "$TRPG_HOME/clients/tui/src/index.tsx" "\$@"
EOF
chmod +x "$TRPG_BIN/loreweaver"

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
