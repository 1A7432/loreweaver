#!/usr/bin/env bash
# Loreweaver terminal client — one-line installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash
#
# It: (1) makes sure `bun` is on PATH (bun is both the runtime AND the package
# manager that auto-resolves the right @opentui/core native core per platform),
# (2) downloads the client tarball from the GitHub Release, (3) `bun install`s it
# via a fast registry mirror, (4) drops a `loreweaver` launcher. Nothing needs root.
#
# In mainland China (GitHub can be slow/blocked) use the mirror instead:
#   TRPG_ORIGIN=https://1a7432.site/trpg  (or run the mirror one-liner from the site)
# Override too: TRPG_HOME (install dir), TRPG_REGISTRY (npm mirror), TRPG_BIN (launcher dir).
set -euo pipefail

TRPG_HOME="${TRPG_HOME:-$HOME/.loreweaver}"
TRPG_REGISTRY="${TRPG_REGISTRY:-https://registry.npmmirror.com}"
TRPG_BIN="${TRPG_BIN:-$HOME/.local/bin}"

# Distribution source: GitHub by default; a mirror (e.g. 1a7432.site) when TRPG_ORIGIN is set.
if [ -n "${TRPG_ORIGIN:-}" ]; then
  TARBALL_URL="${TRPG_ORIGIN}/loreweaver-client.tar.gz"
  INSTALLER_URL="${TRPG_ORIGIN}/install.sh"
  SOURCE_DESC="${TRPG_ORIGIN}"
else
  TARBALL_URL="https://github.com/1A7432/loreweaver/releases/latest/download/loreweaver-client.tar.gz"
  INSTALLER_URL="https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh"
  SOURCE_DESC="GitHub Release"
fi

say() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "need curl"
command -v tar  >/dev/null 2>&1 || die "need tar"

# 1) bun — the runtime + package manager the client is built on.
if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  say "installing bun (runtime + package manager)…"
  curl -fsSL https://bun.sh/install | bash >/dev/null \
    || die "bun install failed. If GitHub is slow where you are, install bun manually (https://bun.sh) then re-run."
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || die "bun still not on PATH — open a new shell and re-run."
say "bun $(bun --version) ready"

# 2) client tarball.
say "downloading client from ${SOURCE_DESC}…"
rm -rf "$TRPG_HOME/clients"
mkdir -p "$TRPG_HOME"
curl -fsSL "$TARBALL_URL" | tar xz -C "$TRPG_HOME" \
  || die "could not fetch the client from ${SOURCE_DESC}. In mainland China try the mirror: TRPG_ORIGIN=https://1a7432.site/trpg curl -fsSL https://1a7432.site/trpg/install.sh | bash"

# 3) deps — bun install resolves the per-platform @opentui/core native core for us.
say "installing dependencies (registry: ${TRPG_REGISTRY})…"
printf 'registry=%s\n' "$TRPG_REGISTRY" > "$TRPG_HOME/clients/.npmrc"
( cd "$TRPG_HOME/clients" && bun install --silent ) \
  || die "bun install failed. Try again, or set TRPG_REGISTRY to another mirror."

# 4) launcher — `loreweaver` (matches the project name). `loreweaver update` re-runs
#    this installer to fetch + reinstall the latest client; anything else launches the TUI.
mkdir -p "$TRPG_BIN"
cat > "$TRPG_BIN/loreweaver" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "update" ]; then
  echo "updating Loreweaver…"
  exec env ${TRPG_ORIGIN:+TRPG_ORIGIN='${TRPG_ORIGIN}'} bash -c "curl -fsSL '${INSTALLER_URL}' | bash"
fi
exec bun run "$TRPG_HOME/clients/tui/src/index.tsx" "\$@"
EOF
chmod +x "$TRPG_BIN/loreweaver"

echo
say "installed ✓"
echo "  Launcher: $TRPG_BIN/loreweaver"
case ":$PATH:" in
  *":$TRPG_BIN:"*) echo "  Run:      loreweaver          (update later with: loreweaver update)" ;;
  *) echo "  '$TRPG_BIN' is not on your PATH yet. Either add it, or run the full path:"
     echo "            $TRPG_BIN/loreweaver" ;;
esac
echo
echo "  In the connect screen, use:"
echo "    host  wss://1a7432.site/ws"
echo "    key   <the invite key your Keeper gave you>"
echo "    name  <your nickname>"
