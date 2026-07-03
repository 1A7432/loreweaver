#!/usr/bin/env bash
# Loreweaver terminal client — one-line installer (macOS / Linux).
#
#   curl -fsSL https://1a7432.site/trpg/install.sh | bash
#
# It: (1) makes sure `bun` is on PATH (bun is both the runtime AND the package
# manager that auto-resolves the right @opentui/core native core per platform),
# (2) downloads the client SOURCE from your server (not GitHub — friendlier from
# China), (3) `bun install`s it via a fast registry mirror, (4) drops a `trpg-kp`
# launcher. Nothing here needs root.
#
# Override anything via env: TRPG_ORIGIN (where install.sh + the tarball live),
# TRPG_HOME (install dir), TRPG_REGISTRY (npm mirror), TRPG_BIN (launcher dir).
set -euo pipefail

TRPG_ORIGIN="${TRPG_ORIGIN:-https://1a7432.site/trpg}"
TRPG_HOME="${TRPG_HOME:-$HOME/.trpg-kp}"
TRPG_REGISTRY="${TRPG_REGISTRY:-https://registry.npmmirror.com}"
TRPG_BIN="${TRPG_BIN:-$HOME/.local/bin}"

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

# 2) client source, straight from your server.
say "downloading client source from ${TRPG_ORIGIN}…"
rm -rf "$TRPG_HOME/clients"
mkdir -p "$TRPG_HOME"
curl -fsSL "${TRPG_ORIGIN}/trpg-kp-client.tar.gz" | tar xz -C "$TRPG_HOME" \
  || die "could not fetch the client source from ${TRPG_ORIGIN} (is the file server up?)"

# 3) deps — bun install resolves the per-platform @opentui/core native core for us.
say "installing dependencies (registry: ${TRPG_REGISTRY})…"
printf 'registry=%s\n' "$TRPG_REGISTRY" > "$TRPG_HOME/clients/.npmrc"
( cd "$TRPG_HOME/clients" && bun install --silent ) \
  || die "bun install failed. Try again, or set TRPG_REGISTRY to another mirror."

# 4) launcher.
mkdir -p "$TRPG_BIN"
cat > "$TRPG_BIN/trpg-kp" <<EOF
#!/usr/bin/env bash
exec bun run "$TRPG_HOME/clients/tui/src/index.tsx" "\$@"
EOF
chmod +x "$TRPG_BIN/trpg-kp"

echo
say "installed ✓"
echo "  Launcher: $TRPG_BIN/trpg-kp"
case ":$PATH:" in
  *":$TRPG_BIN:"*) echo "  Run:      trpg-kp" ;;
  *) echo "  '$TRPG_BIN' is not on your PATH yet. Either add it, or run the full path:"
     echo "            $TRPG_BIN/trpg-kp" ;;
esac
echo
echo "  In the connect screen, use:"
echo "    host  wss://1a7432.site/ws"
echo "    key   <the invite key your Keeper gave you>"
echo "    name  <your nickname>"
