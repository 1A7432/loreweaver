#!/usr/bin/env bash
# Regenerate the real README/site TUI screenshots (macOS).
# Pipeline: run the REAL OpenTUI renderer (src/screenshot.tsx) inside tmux, capture the
# rendered screen as truecolor ANSI, then draw it to a PNG on a FIXED cell grid
# (screenshot-render.py) so CJK stays aligned — no browser/pre CJK-advance drift.
# Needs: bun, tmux, Python+Pillow, and Sarasa Mono (`brew install --cask font-sarasa-gothic`).
#
# Five screens x two languages -> ten PNGs. The hero "game" shot keeps the legacy
# tui-en.png / tui-zh.png names (README/site already link them); the rest are
# tui-<screen>-<lang>.png. Pass a screen name (or "all", the default) to capture
# a subset, e.g. `./capture-screenshots.sh connect` or `./capture-screenshots.sh
# all /tmp/out`.
set -euo pipefail
cd "$(dirname "$0")"
# Clear any stray renderer from an earlier/aborted run FIRST: a pile of zombie bun
# processes starves the 10 concurrent sessions below and they get captured pre-boot.
pkill -f "bun run src/screenshot.tsx" 2>/dev/null || true

SCREENS_ARG="${1:-all}"
OUT="${2:-../../assets}"
BUN=$(command -v bun)
mkdir -p "$OUT"

if [ "$SCREENS_ARG" = "all" ]; then
  SCREENS="game connect menu character skills"
else
  SCREENS="$SCREENS_ARG"
fi

title_en="loreweaver — the lamplit table"; title_zh="loreweaver — 灯下的牌桌"

session_for() { echo "shot_$1_$2"; }

for S in $SCREENS; do
  for L in en zh; do
    sess=$(session_for "$S" "$L")
    tmux kill-session -t "$sess" 2>/dev/null || true
    tmux new-session -d -s "$sess" -x 128 -y 34
    tmux send-keys -t "$sess" "SHOT_SCREEN=$S SHOT_LANG=$L TERM=xterm-256color COLORTERM=truecolor $BUN run src/screenshot.tsx" Enter
  done
done

# Bun boot + first frame ~5-7s.
sleep 16

# The `character` screen has no character yet, so it mounts straight on the
# create form (method="roll" by default) — send real keystrokes over the tmux
# pty so the shot instead shows "manual" (all four methods still list above it)
# together with its point-budget line, and the flavor name typed into the form:
#   Down (method: roll -> manual) -> Enter (confirm, focus -> system, left on
#   CoC) -> Tab (system -> name) -> type the name -> Tab (name -> attrs).
if echo " $SCREENS " | grep -q " character "; then
  for L in en zh; do
    sess=$(session_for character "$L")
    name=$([ "$L" = "zh" ] && echo "张伟" || echo "Alex")
    tmux send-keys -t "$sess" Down
    sleep 0.3
    tmux send-keys -t "$sess" Enter
    sleep 0.3
    tmux send-keys -t "$sess" Tab
    sleep 0.3
    tmux send-keys -t "$sess" -l "$name"
    sleep 0.3
    tmux send-keys -t "$sess" Tab
    sleep 0.3
  done
fi

for S in $SCREENS; do
  for L in en zh; do
    sess=$(session_for "$S" "$L")
    ansi="/tmp/lw-shot-$S-$L.ansi"
    tmux capture-pane -p -e -t "$sess" > "$ansi"
    tmux kill-session -t "$sess" 2>/dev/null || true
    t="title_$L"
    if [ "$S" = "game" ]; then
      out="$OUT/tui-$L.png"
    else
      out="$OUT/tui-$S-$L.png"
    fi
    python3 screenshot-render.py "$ansi" "$out" "${!t}"
  done
done
