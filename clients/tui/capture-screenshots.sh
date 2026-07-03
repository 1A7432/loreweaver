#!/usr/bin/env bash
# Capture a real screenshot of the Loreweaver TUI:
#   tmux runs the real renderer -> capture-pane -e (truecolor ANSI) -> aha -> HTML shell -> Chrome PNG.
# Usage: capture-tui.sh <en|zh> <out.png> <font-family>
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
LANG_="${1:-en}"; OUT="${2:?out path}"; FONT="${3:-'SF Mono', Menlo, monospace}"
TUI=/Users/darthvader/ClaudeCode/trpg_kp/clients/tui
BUN=$(which bun); CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
S="lwshot_$LANG_"; ANSI="/tmp/lw-$LANG_.ansi"; HTML="/tmp/lw-$LANG_.html"

tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 118 -y 33
tmux send-keys -t "$S" "cd $TUI && SHOT_LANG=$LANG_ TERM=xterm-256color COLORTERM=truecolor $BUN run src/screenshot.tsx" Enter
sleep 6
tmux capture-pane -p -e -t "$S" > "$ANSI"
tmux kill-session -t "$S" 2>/dev/null || true

aha --no-header < "$ANSI" > /tmp/aha-$LANG_.html
FONT="$FONT" python3 - "$LANG_" > "$HTML" <<'PY'
import os,re,sys
lang=sys.argv[1]
body=open(f'/tmp/aha-{lang}.html').read()
m=re.search(r'<pre>(.*)</pre>', body, re.S); inner=m.group(1) if m else body
font=os.environ['FONT']
title="loreweaver — 灯下的牌桌" if lang=="zh" else "loreweaver — the lamplit table"
print(f'''<!doctype html><meta charset=utf-8><style>
body{{margin:0;background:#0d0a06;padding:30px;font-family:{font}}}
.term{{background:#17130E;border:1px solid #4A3F30;border-radius:12px;overflow:hidden;box-shadow:0 34px 80px rgba(0,0,0,.55);display:inline-block}}
.bar{{display:flex;gap:8px;align-items:center;padding:11px 15px;background:rgba(0,0,0,.30);border-bottom:1px solid #4A3F30}}
.dot{{width:11px;height:11px;border-radius:50%}} .r{{background:#7c3a2c}}.y{{background:#9a7d34}}.g{{background:#4c7a68}}
.tt{{margin-left:10px;color:#8A7B5E;font-size:12px;letter-spacing:.12em}}
pre{{margin:0;padding:14px 18px;font-size:13px;line-height:1.34;color:#E7D8B5;background:#17130E;white-space:pre}}
</style>
<div class="term"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="tt">{title}</span></div>
<pre>{inner}</pre></div>''')
PY

"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1120,780 --default-background-color=0d0a06ff --screenshot="$OUT" "file://$HTML" >/dev/null 2>&1
echo "wrote $OUT ($(stat -f%z "$OUT" 2>/dev/null || echo 0) bytes)"
