#!/usr/bin/env python3
"""NEXORA-MD showcase poster: banner + stats hero + FULL menu, ek hi khubsurat pic.
Usage: python3 render_poster.py <menu.txt> <out.png>
Boss (2026-09-24): kisi ko dikhana ho ke kya features hain — high level poster.
"""
import sys, re
from PIL import Image, ImageDraw, ImageFont

W = 1080
PAD_X = 48
BG = (0, 22, 25)        # #001619 rexai
CARD = (6, 37, 41)      # #062529
CYAN = (80, 232, 244)   # #50E8F4
WHITE = (234, 247, 248) # #EAF7F8
DIM = (127, 163, 167)   # #7FA3A7
PINK = (255, 120, 170)

FD = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FDB = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FE = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'
BANNER = '/home/hatch/workspace/whatsapp-md-bot/assets/nexora-banner.jpg'

EMOJI_RE = re.compile(r'[\U0001F000-\U0001FAFF\u2600-\u27BF]')
SKIP = {'\uFE0F', '\u200D'}
BRACKETS = '\u3014\u3015'

def main(txt_path, out_path):
    with open(txt_path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    # command count from menu header
    ncmd = '380'
    for l in lines[:12]:
        if 'Commands' in l:
            import re as _re
            m = _re.search(r'(\d+)', l)
            if m:
                ncmd = m.group(1)

    FS = 25
    def fonts(fs):
        return (ImageFont.truetype(FD, fs), ImageFont.truetype(FDB, fs),
                ImageFont.truetype(FDB, fs + 3), ImageFont.truetype(FD, fs + 3),
                ImageFont.truetype(FDB, 34))
    font = font_b = head_b = head_r = big_b = None

    def char_font(ch, fnt):
        if ch in BRACKETS:
            return head_r if fnt == head_b else font
        return fnt

    def measure_w(line, fnt=None):
        w = 0
        for ch in line:
            if ch in SKIP:
                continue
            if ch == '\u2b21' or not EMOJI_RE.match(ch):
                f = char_font(ch, fnt or font_b)
                w += f.getlength(ch)
            else:
                w += (FS + 5) + 2
        return w

    def wrap_lines(ls):
        out, maxw = [], W - PAD_X * 2
        for line in ls:
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
        font, font_b, head_b, head_r, big_b = fonts(FS)
        lines = wrap_lines(orig)
        if all(measure_w(l) <= W - PAD_X * 2 for l in lines) or FS <= 17:
            break
        FS -= 1
    LINE_H = int(FS * 1.62)
    EMOJI_PX = FS + 5
    efont = ImageFont.truetype(FE, 109)

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

    # hero stats strip height
    hero_h = 150
    foot_h = 120
    H = banner.size[1] + 20 + hero_h + 10 + len(lines) * LINE_H + 40 + foot_h
    img = Image.new('RGB', (W, H), BG)
    img.paste(banner, (0, 0))
    d = ImageDraw.Draw(img)
    y = banner.size[1] + 20

    # hero card
    d.rounded_rectangle([PAD_X, y, W - PAD_X, y + hero_h], radius=22, fill=CARD, outline=CYAN, width=3)
    t1 = f'{ncmd}+ COMMANDS'
    t2 = 'AI-Powered WhatsApp Bot  •  24/7 Online  •  Prefix  .'
    w1 = big_b.getlength(t1)
    d.text(((W - w1) / 2, y + 22), t1, font=big_b, fill=CYAN)
    w2 = font.getlength(t2)
    d.text(((W - w2) / 2, y + 78), t2, font=font, fill=WHITE)
    y += hero_h + 26

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
        if '\u3014' in line:
            seg(PAD_X, y, line, head_b, CYAN)
        elif line.startswith('\u2503 \u2b21'):
            x = seg(PAD_X, y, '\u2503 \u2b21 ', font_b, CYAN)
            rest = line[4:]
            if ' \u2014 ' in rest:
                cmd, desc = rest.split(' \u2014 ', 1)
                x = seg(x, y, cmd, font_b, WHITE)
                seg(x, y, ' \u2014 ' + desc, font, DIM)
            else:
                seg(x, y, rest, font_b, WHITE)
        elif line.startswith('\u2503'):
            x = seg(PAD_X, y, '\u2503 ', font_b, CYAN)
            seg(x, y, line[2:], font, WHITE)
        else:
            seg(PAD_X, y, line, font, CYAN)
        y += LINE_H

    # footer
    y += 10
    f1 = 'Main Nexa hoon — tumhari AI assistant'
    f2 = 'NEXORA-MD'
    w = font_b.getlength(f1)
    # pink heart drawn as emoji tile
    hx = (W - w) / 2 - 44
    img.paste(tile('\U0001F497'), (int(hx), int(y)), tile('\U0001F497'))
    d.text(((W - w) / 2, y + 4), f1, font=font_b, fill=WHITE)
    w = big_b.getlength(f2)
    d.text(((W - w) / 2, y + 52), f2, font=big_b, fill=PINK)

    img.save(out_path)
    print('saved', out_path, img.size, 'font', FS)

main(sys.argv[1], sys.argv[2])
