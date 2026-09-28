#!/usr/bin/env python3
"""NEXORA-MD: menu text -> Rexai styled PNG (banner + full menu, single image).
Usage: python3 render_menu.py <menu.txt> <out.png>
Boss (2026-09-24): .menu ab EK hi message mein pic+menu bhejta hai.
"""
import sys, re
from PIL import Image, ImageDraw, ImageFont

W = 1000
PAD_X = 44
BG = (0, 22, 25)        # #001619 rexai
CYAN = (80, 232, 244)   # #50E8F4
WHITE = (234, 247, 248) # #EAF7F8
DIM = (127, 163, 167)   # #7FA3A7

FD = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FDB = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FE = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'
BANNER = '/home/hatch/workspace/whatsapp-md-bot/assets/nexora-banner.jpg'

EMOJI_RE = re.compile(r'[\U0001F000-\U0001FAFF\u2600-\u27BF]')
SKIP = {'\uFE0F', '\u200D'}  # variation selector / ZWJ: draw nahi karte

def main(txt_path, out_path):
    with open(txt_path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    def fonts(fs):
        return (ImageFont.truetype(FD, fs), ImageFont.truetype(FDB, fs),
                ImageFont.truetype(FDB, fs + 2), ImageFont.truetype(FD, fs + 2))

    FS = 25
    BRACKETS = '\u3014\u3015'  # 〔 〕 Bold mein nahi — regular fallback
    font = font_b = head_b = head_r = None

    def char_font(ch, fnt):
        if ch in BRACKETS:
            return head_r if fnt == head_b else font
        return fnt

    def measure_w(line):
        w = 0
        for ch in line:
            if ch in SKIP:
                continue
            if ch == '\u2b21' or not EMOJI_RE.match(ch):
                f = char_font(ch, font_b)
                w += f.getlength(ch)
            else:
                w += (FS + 5) + 2
        return w

    def wrap_lines(lines):
        out, maxw = [], W - PAD_X * 2
        for line in lines:
            if measure_w(line) <= maxw or not line.strip():
                out.append(line)
                continue
            if line.startswith('\u2503 \u2b21 '):
                prefix, cont, body = '\u2503 \u2b21 ', '\u2503    ', line[4:]
            elif line.startswith('\u2503 '):
                prefix, cont, body = '\u2503 ', '\u2503  ', line[2:]
            else:
                prefix, cont, body = '', '', line
            cur, first = '', True
            for wd in body.split(' '):
                trial = (cur + ' ' + wd).strip()
                if measure_w((prefix if first else cont) + trial) <= maxw:
                    cur = trial
                else:
                    out.append((prefix if first else cont) + cur)
                    cur, first = wd, False
            out.append((prefix if first else cont) + cur)
        return out

    orig = lines
    while True:
        font, font_b, head_b, head_r = fonts(FS)
        lines = wrap_lines(orig)
        if all(measure_w(l) <= W - PAD_X * 2 for l in lines) or FS <= 17:
            break
        FS -= 1
    LINE_H = int(FS * 1.6)
    EMOJI_PX = FS + 5
    efont = ImageFont.truetype(FE, 109)  # NotoColorEmoji: only size 109 loads

    tiles = {}
    def tile(ch):
        if ch not in tiles:
            t = Image.new('RGBA', (109, 109), (0, 0, 0, 0))
            ImageDraw.Draw(t).text((0, 0), ch, font=efont, embedded_color=True)
            tiles[ch] = t.resize((EMOJI_PX, EMOJI_PX), Image.LANCZOS)
        return tiles[ch]

    banner = Image.open(BANNER).convert('RGB')
    bw, bh = banner.size
    banner = banner.resize((W, int(bh * W / bw)), Image.LANCZOS)

    H = banner.size[1] + 26 + len(lines) * LINE_H + 60
    img = Image.new('RGB', (W, H), BG)
    img.paste(banner, (0, 0))
    d = ImageDraw.Draw(img)
    dy = banner.size[1] + 12
    d.rectangle([PAD_X, dy, W - PAD_X, dy + 3], fill=CYAN)
    y = dy + 14

    def seg(x, yy, s, fnt, color):
        for ch in s:
            if ch in SKIP:
                continue
            if ch == '\u2b21' or not EMOJI_RE.match(ch):
                f = char_font(ch, fnt)
                d.text((x, yy), ch, font=f, fill=color)
                x += int(f.getlength(ch))
            else:
                t = tile(ch)
                img.paste(t, (x, int(yy + (LINE_H - EMOJI_PX) / 2 - 3)), t)
                x += EMOJI_PX + 2
        return x

    for line in lines:
        if not line.strip():
            y += LINE_H
            continue
        if '\u3014' in line:  # 〔 〕 header
            seg(PAD_X, y, line, head_b, CYAN)
        elif line.startswith('\u2503 \u2b21'):  # ┃ ⬡ command
            x = seg(PAD_X, y, '\u2503 \u2b21 ', font_b, CYAN)
            rest = line[4:]
            if ' \u2014 ' in rest:
                cmd, desc = rest.split(' \u2014 ', 1)
                x = seg(x, y, cmd, font_b, WHITE)
                seg(x, y, ' \u2014 ' + desc, font, DIM)
            else:
                seg(x, y, rest, font_b, WHITE)
        elif line.startswith('\u2503'):  # info lines
            x = seg(PAD_X, y, '\u2503 ', font_b, CYAN)
            seg(x, y, line[2:], font, WHITE)
        else:  # box borders
            seg(PAD_X, y, line, font, CYAN)
        y += LINE_H

    img.save(out_path)
    print('saved', out_path, img.size, 'font', FS)

main(sys.argv[1], sys.argv[2])
