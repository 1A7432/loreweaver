#!/usr/bin/env bash
# Run a Codex headless (gpt-5.5 xhigh) implementation task against this repo.
# Usage: scripts/codex_task.sh <label> <prompt-file>
# Prints the run, writes the agent's final message to scratchpad/codex_<label>.last.txt
set -uo pipefail
ROOT="/Users/darthvader/ClaudeCode/trpg_kp"
LABEL="${1:?label}"
PROMPT_FILE="${2:?prompt file}"
OUT="/private/tmp/claude-501/-Users-darthvader-ClaudeCode-trpg-kp/0a8afb55-12c0-427b-b7b5-8072c260461e/scratchpad/codex_${LABEL}.last.txt"
codex exec -C "$ROOT" -s workspace-write --color never \
  --output-last-message "$OUT" \
  - < "$PROMPT_FILE"
echo "=== [$LABEL] final message ==="
cat "$OUT" 2>/dev/null | tail -40
