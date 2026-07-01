#!/usr/bin/env bash
#
# Loreweaver — one-click self-hosted deploy.
#
#   scripts/deploy.sh                 # Docker (default): build + start the WS server, detached
#   scripts/deploy.sh --bare-metal    # No Docker: venv + pip install + run in the foreground
#   scripts/deploy.sh --down          # Stop + remove the Docker stack
#   scripts/deploy.sh --help
#
# Idempotent: safe to re-run. Reads config from ./.env (created from
# .env.example on first run). Set TRPG_LLM__* in .env for a real AI Keeper;
# with no key the bundled offline demo Keeper runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TRPG_PORT:-8787}"
DEMO_ROOM="table"
MODE="docker"

for arg in "$@"; do
  case "$arg" in
    --bare-metal|--baremetal) MODE="baremetal" ;;
    --down|--stop)            MODE="down" ;;
    -h|--help)                MODE="help" ;;
    *) echo "deploy.sh: unknown argument '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

# --- helpers ---------------------------------------------------------------

have()  { command -v "$1" >/dev/null 2>&1; }
info()  { printf '  %s\n' "$*"; }
step()  { printf '\n==> %s\n' "$*"; }

# Resolve the Docker Compose CLI (v2 plugin `docker compose`, or legacy binary).
dc() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif have docker-compose;             then docker-compose "$@";
  else echo "deploy.sh: Docker Compose not found" >&2; return 1; fi
}

ensure_env() {
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    step "Created .env from .env.example"
    info "Edit .env and set your provider before connecting a real Keeper, e.g.:"
    info "  TRPG_LLM__PROVIDER=deepseek"
    info "  TRPG_LLM__API_KEY=sk-...   TRPG_LLM__CHAT_MODEL=deepseek-chat"
    info "(Leave the key blank to run the bundled offline demo Keeper.)"
  fi
}

print_help() {
  cat <<'EOF'
Loreweaver — one-click self-hosted deploy.

  scripts/deploy.sh                 # Docker (default): build + start the WS server, detached
  scripts/deploy.sh --bare-metal    # No Docker: venv + pip install + run in the foreground
  scripts/deploy.sh --down          # Stop + remove the Docker stack
  scripts/deploy.sh --help

Idempotent: safe to re-run. Reads config from ./.env (created from .env.example
on first run). Set TRPG_LLM__* in .env for a real AI Keeper; with no key the
bundled offline demo Keeper runs. See docs/deploy.md for the full guide.
EOF
}

# --- modes -----------------------------------------------------------------

deploy_docker() {
  if ! have docker; then
    echo "deploy.sh: Docker is not installed. Install Docker, or run: scripts/deploy.sh --bare-metal" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "deploy.sh: the Docker daemon isn't reachable. Start Docker Desktop / dockerd and retry." >&2
    exit 1
  fi

  ensure_env

  step "Building image + starting the server (detached)"
  dc up -d --build

  step "Loreweaver is up"
  info "WebSocket : ws://localhost:${PORT}/   (published from the container)"
  info "Logs      : docker compose logs -f"
  info "Stop      : docker compose down   (or: scripts/deploy.sh --down)"

  step "Mint an access key (binds a player/keeper to a room)"
  info "docker compose run --rm loreweaver --tui-key add --room ${DEMO_ROOM} --name Keeper --role keeper"
  info "docker compose run --rm loreweaver --tui-key add --room ${DEMO_ROOM} --name Alice"
  info "Then connect a client with the printed key (see docs/deploy.md):"
  info "  cd clients/tui && bun install && bun run dev -- connect --host ws://localhost:${PORT}/ --key <key>"
}

deploy_baremetal() {
  if ! have python3; then
    echo "deploy.sh: python3 (>=3.11) is required for --bare-metal" >&2
    exit 1
  fi

  local PY="$ROOT/.venv/bin/python"
  if [ ! -x "$PY" ]; then
    step "Creating virtualenv (.venv)"
    python3 -m venv "$ROOT/.venv"
  fi

  step "Installing loreweaver (editable, with anthropic + gemini extras)"
  "$ROOT/.venv/bin/pip" install --upgrade pip >/dev/null
  "$ROOT/.venv/bin/pip" install -e ".[anthropic,gemini]"

  ensure_env

  # Colocate the store + keys under ./data so they persist and are easy to find.
  export TRPG_DATA_DIR="${TRPG_DATA_DIR:-$ROOT/data}"
  export TRPG_TUI_KEYS="${TRPG_TUI_KEYS:-$TRPG_DATA_DIR/keys.toml}"
  mkdir -p "$TRPG_DATA_DIR"

  # First run: mint one keeper key so you can connect immediately. Idempotent —
  # skipped once the keystore exists (mint more with the command printed below).
  if [ ! -s "$TRPG_TUI_KEYS" ]; then
    step "Minting a starter keeper key for room '${DEMO_ROOM}'"
    local OUT KEY
    OUT="$(TRPG_LOCALE=en "$PY" -m app --tui-key add --room "$DEMO_ROOM" --name Keeper --role keeper 2>&1)"
    KEY="$(printf '%s' "$OUT" | sed -nE 's/.*: ([A-Za-z0-9_-]{12,})$/\1/p' | tail -1)"
    info "Key: ${KEY:-<see keystore: $TRPG_TUI_KEYS>}"
    info "Connect: cd clients/tui && bun install && bun run dev -- connect --host ws://localhost:${PORT}/ --key ${KEY}"
  else
    step "Keystore already exists ($TRPG_TUI_KEYS)"
    info "Mint more keys (in another terminal):"
    info "  .venv/bin/python -m app --tui-key add --room ${DEMO_ROOM} --name Alice"
  fi

  step "Starting the WebSocket server in the FOREGROUND (Ctrl-C to stop)"
  info "Listening on ws://0.0.0.0:${PORT}/"
  exec "$PY" -m app --serve --host 0.0.0.0 --port "$PORT"
}

# --- dispatch --------------------------------------------------------------

case "$MODE" in
  help)      print_help ;;
  down)      dc down; step "Stopped." ;;
  baremetal) deploy_baremetal ;;
  docker)    deploy_docker ;;
esac
