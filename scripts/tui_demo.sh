#!/usr/bin/env bash
# One-command networked-TUI demo: mint a key, start the Python Iroh p2p server, and
# print the exact client command (with the shareable ticket) to run in another terminal.
# Usage: scripts/tui_demo.sh [room] [name]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
ROOM="${1:-blackmoor}"
NAME="${2:-Keeper}"
KEYS="$ROOT/data/tui_keys.toml"
mkdir -p "$ROOT/data"

# Mint a key for this room (a fresh one each run; keys accumulate in the file).
MINT="$("$PY" -m app --tui-key add --room "$ROOM" --name "$NAME" --keys "$KEYS" 2>&1)"
KEY="$(printf '%s' "$MINT" | sed -nE 's/.*: ([A-Za-z0-9_-]{12,})$/\1/p' | tail -1)"

# Start the Iroh p2p server in the background so we can surface its ticket, then wait on it.
# (WebSocket is no longer a serve option — Iroh needs no domain/TLS/port-forward.)
TICKET_FILE="$ROOT/data/iroh-ticket.txt"
rm -f "$TICKET_FILE"
"$PY" -m app --serve --keys "$KEYS" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

# The endpoint writes its ticket to the sidecar once the relay handshake completes (~10s).
TICKET=""
for _ in $(seq 1 60); do
  if [ -s "$TICKET_FILE" ]; then
    TICKET="$(sed -nE 's/^ticket=(.+)$/\1/p' "$TICKET_FILE")"
    [ -n "$TICKET" ] && break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "✗ server exited before it was ready" >&2; exit 1; }
  sleep 1
done
[ -n "$TICKET" ] || { echo "✗ timed out waiting for the Iroh ticket (relay unreachable?)" >&2; exit 1; }

cat <<EOF

  loreweaver — networked terminal demo (p2p over Iroh)
  ----------------------------------------------------
  Room   : $ROOM     Player: $NAME
  Key    : $KEY
  Ticket : $TICKET

  Server is up (Ctrl-C to stop). In ANOTHER terminal, connect the OpenTUI client —
  the ticket dials this host directly, no domain/TLS/port-forward:

    cd $ROOT/clients/tui && bun install
    bun run dev -- connect --host $TICKET --key $KEY --name "$NAME"

  Share more keys for the SAME room so friends join the same session:
    $PY -m app --tui-key add --room $ROOM --name Alice --keys $KEYS

EOF

wait "$SERVER_PID"
