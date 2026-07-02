#!/usr/bin/env bash
# Run a Codex headless (gpt-5.5 xhigh) implementation task against this repo.
# Usage: scripts/codex_task.sh <label> <prompt-file>
# Prints the run, writes the agent's final message to $CODEX_SCRATCH_DIR/codex_<label>.last.txt
# (default: <repo>/scratch, gitignored -- override with CODEX_SCRATCH_DIR for a
# session-specific location, e.g. a Claude Code scratchpad dir).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${1:?label}"
PROMPT_FILE="${2:?prompt file}"
SCRATCH_DIR="${CODEX_SCRATCH_DIR:-$ROOT/scratch}"
mkdir -p "$SCRATCH_DIR"
OUT="$SCRATCH_DIR/codex_${LABEL}.last.txt"
codex exec -C "$ROOT" -s workspace-write --color never \
  --output-last-message "$OUT" \
  - < "$PROMPT_FILE"
echo "=== [$LABEL] final message ==="
cat "$OUT" 2>/dev/null | tail -40
