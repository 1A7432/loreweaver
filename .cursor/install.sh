#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Loreweaver.
# Installs the two toolchains the default image lacks (uv for the Python engine,
# bun for the TypeScript clients), then refreshes all locked dependencies.
# Safe to run repeatedly and against cached/snapshot state.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- uv (Python engine) --------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
# uv's installer writes ~/.local/bin/env and the profile snippet; source it so
# this non-interactive shell can see uv immediately.
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
export PATH="$HOME/.local/bin:$PATH"

# --- bun (TypeScript clients) --------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# --- Python deps (matches .github/workflows/ci.yml) ----------------------
# anthropic + gemini: the two native (non-OpenAI) provider classes.
# ejs: the QuickJS sandbox the untrusted-code lanes run in.
# --locked asserts uv.lock is current; the dev group (pytest/ruff) is default.
uv sync --locked --extra anthropic --extra gemini --extra ejs

# --- TypeScript client deps ----------------------------------------------
( cd clients/protocol && bun install )
( cd clients/tui && bun install )

echo "Loreweaver install complete: $(uv --version), bun $(bun --version)"
