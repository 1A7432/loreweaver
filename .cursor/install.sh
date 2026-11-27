#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Loreweaver.
# Installs Bun (the one toolchain: server, module SDK and clients are one workspace)
# and the locked dependencies. Safe to run repeatedly and against cached/snapshot state.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# One workspace for the whole repository (the root package.json and bun.lock).
bun install --frozen-lockfile

echo "Loreweaver install complete: bun $(bun --version)"
