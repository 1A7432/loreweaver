#!/usr/bin/env bash
# One-command networked-TUI demo: mint a key, start the Python WS server, and
# print the exact client command to run in another terminal.
# Usage: scripts/tui_demo.sh [room] [name] [port]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
ROOM="${1:-blackmoor}"
NAME="${2:-Keeper}"
PORT="${3:-8787}"
KEYS="$ROOT/data/tui_keys.toml"
mkdir -p "$ROOT/data"

# Mint a key for this room (a fresh one each run; keys accumulate in the file).
MINT="$("$PY" -m app --tui-key add --room "$ROOM" --name "$NAME" --keys "$KEYS" 2>&1)"
KEY="$(printf '%s' "$MINT" | sed -nE 's/.*: ([A-Za-z0-9_-]{12,})$/\1/p' | tail -1)"

cat <<EOF

  trpg_kp — networked terminal demo
  ---------------------------------
  Room : $ROOM     Player: $NAME
  Key  : $KEY

  Server starting on ws://127.0.0.1:$PORT/  (Ctrl-C to stop)

  In ANOTHER terminal, connect the OpenTUI client:

    cd $ROOT/clients/tui && bun install
    bun run dev -- connect --host ws://127.0.0.1:$PORT/ --key $KEY --name "$NAME"

  Share more keys for the SAME room so friends join the same session:
    $PY -m app --tui-key add --room $ROOM --name Alice --keys $KEYS

EOF

exec "$PY" -m app --serve --host 127.0.0.1 --port "$PORT" --keys "$KEYS"
