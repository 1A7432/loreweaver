#!/usr/bin/env bash
# Regenerate the real README/site TUI screenshots (macOS).
# Pipeline: run the REAL OpenTUI renderer (src/screenshot.tsx) inside tmux, capture the
# rendered screen as truecolor ANSI, then draw it to a PNG on a FIXED cell grid
# (screenshot-render.py) so CJK stays aligned — no browser/pre CJK-advance drift.
# Needs: bun, tmux, Python+Pillow, and Sarasa Mono (`brew install --cask font-sarasa-gothic`).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-../../assets}"; BUN=$(command -v bun)
for L in en zh; do
  tmux kill-session -t shot_$L 2>/dev/null || true
  tmux new-session -d -s shot_$L -x 118 -y 34
  tmux send-keys -t shot_$L "SHOT_LANG=$L TERM=xterm-256color COLORTERM=truecolor $BUN run src/screenshot.tsx" Enter
done
sleep 7
title_en="loreweaver — the lamplit table"; title_zh="loreweaver — 灯下的牌桌"
for L in en zh; do
  tmux capture-pane -p -e -t shot_$L > "/tmp/lw-shot-$L.ansi"
  tmux kill-session -t shot_$L 2>/dev/null || true
  t="title_$L"
  python3 screenshot-render.py "/tmp/lw-shot-$L.ansi" "$OUT/tui-$L.png" "${!t}"
done
