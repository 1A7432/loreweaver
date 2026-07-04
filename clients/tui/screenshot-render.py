#!/usr/bin/env python3
# Render a tmux `capture-pane -e` dump to a PIXEL-PERFECT PNG by placing every
# character on a fixed cell grid (wide/CJK glyphs occupy 2 cells) — sidesteps the
# browser's inexact CJK advance. Handles truecolor fg AND bg (so the status bar and
# selected rows render). One font (Sarasa Mono SC: Latin + CJK) keeps it consistent.
import re, sys, os, unicodedata
from PIL import Image, ImageDraw, ImageFont

ANSI, OUT, TITLE = sys.argv[1], sys.argv[2], sys.argv[3]
SZ, CW, CH, PAD, BAR, MARGIN = 20, 10, 26, 20, 46, 22
BG = (0x17, 0x13, 0x0E); OUTER = (0x0d, 0x0a, 0x06); LINE = (0x4A, 0x3F, 0x30)
DEF = (0xE7, 0xD8, 0xB5); DIM = (0x8A, 0x7B, 0x5E)
SARASA = os.path.expanduser("~/Library/Fonts/Sarasa-SuperTTC.ttc")
FONT = ImageFont.truetype(SARASA, SZ, index=205)  # Sarasa Mono SC Regular

raw = open(ANSI, encoding="utf-8", errors="replace").read()
def is_wide(ch): return unicodedata.east_asian_width(ch) in ("W", "F")

sgr = re.compile(r"\x1b\[([0-9;]*)m")
cells, row, fg, bg = [], [], DEF, None
i = 0
while i < len(raw):
    if raw[i] == "\x1b":
        m = sgr.match(raw, i)
        if m:
            ps = m.group(1).split(";"); k = 0
            while k < len(ps):
                p = ps[k]
                if p in ("", "0"): fg, bg = DEF, None
                elif p == "39": fg = DEF
                elif p == "49": bg = None
                elif p == "38" and k + 4 < len(ps) and ps[k+1] == "2":
                    fg = (int(ps[k+2]), int(ps[k+3]), int(ps[k+4])); k += 4
                elif p == "48" and k + 4 < len(ps) and ps[k+1] == "2":
                    bg = (int(ps[k+2]), int(ps[k+3]), int(ps[k+4])); k += 4
                k += 1
            i = m.end(); continue
        i += 1; continue
    ch = raw[i]
    if ch == "\n": cells.append(row); row = []; i += 1; continue
    if ch == "\r": i += 1; continue
    row.append((ch, fg, bg, is_wide(ch))); i += 1
if row: cells.append(row)
while cells and not any(c[0].strip() or c[2] for c in cells[-1]): cells.pop()

# Canvas width follows the widest captured row (display cells: wide CJK counts as 2)
# instead of a hardcoded terminal width — capture-screenshots.sh's tmux size is the
# single source of truth.
ncols = max((sum(2 if c[3] else 1 for c in r) for r in cells), default=80)
nrows = len(cells)
W = MARGIN * 2 + PAD * 2 + ncols * CW
H = MARGIN * 2 + BAR + PAD * 2 + nrows * CH
img = Image.new("RGB", (W, H), OUTER)
d = ImageDraw.Draw(img)
d.rounded_rectangle([MARGIN, MARGIN, W - MARGIN, H - MARGIN], radius=14, fill=BG, outline=LINE)
by = MARGIN + BAR
d.line([MARGIN, by, W - MARGIN, by], fill=LINE)
for j, c in enumerate([(0x7c,0x3a,0x2c), (0x9a,0x7d,0x34), (0x4c,0x7a,0x68)]):
    cx = MARGIN + 22 + j * 22
    d.ellipse([cx, MARGIN + 16, cx + 13, MARGIN + 29], fill=c)
d.text((MARGIN + 96, MARGIN + 14), TITLE, font=FONT, fill=DIM)

ox, oy = MARGIN + PAD, by + PAD
for r, line in enumerate(cells):
    col = 0
    for ch, fgc, bgc, w in line:
        x, y = ox + col * CW, oy + r * CH
        cw = 2 * CW if w else CW
        if bgc is not None:
            d.rectangle([x, y, x + cw, y + CH], fill=bgc)
        if ch != " ":
            d.text((x, y), ch, font=FONT, fill=fgc)
        col += 2 if w else 1
img.save(OUT)
print(f"wrote {OUT} ({W}x{H}, {nrows} rows)")
