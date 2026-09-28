#!/usr/bin/env python3
"""Real-feel WhatsApp demo video frame renderer (PIL only, no browser).
Usage: python3 render.py <cmd> <user_text> <bot_reply> <outdir>
Generates PNG frames at 10fps showing: typing -> sent -> bot typing -> reply.
"""
import sys, os, math
from PIL import Image, ImageDraw, ImageFont

W, H = 720, 1280
FPS = 10
BG = (11, 20, 26)          # WhatsApp dark bg #0b141a
HEADER_BG = (31, 44, 52)   # #1f2c34
OUT_BG = (0, 92, 75)       # #005c4b outgoing
IN_BG = (31, 44, 52)       # #1f2c34 incoming
TXT = (255, 255, 255)
DIM = (150, 170, 175)
GREEN = (0, 168, 132)
BLUE_TICK = (83, 189, 235)

def font(sz):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              "/usr/share/fonts/TTF/DejaVuSans.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()

F_TITLE = font(34); F_SUB = font(24); F_MSG = font(30); F_TIME = font(20); F_INP = font(30)

def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

def wrap(draw, text, fnt, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= maxw: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines or [""]

def draw_header(d, name, typing=False):
    d.rectangle([0, 0, W, 130], fill=HEADER_BG)
    # back arrow
    d.text((24, 42), "\u2039", font=font(54), fill=TXT)
    # avatar circle
    d.ellipse([80, 28, 152, 100], fill=(0, 168, 132))
    d.text((104, 46), "N", font=font(40), fill=(255, 255, 255))
    d.text((180, 34), name, font=F_TITLE, fill=TXT)
    d.text((180, 78), "typing..." if typing else "online", font=F_SUB,
           fill=GREEN if typing else DIM)
    # video/call icons (simple)
    d.text((W - 130, 44), "\u260E", font=font(36), fill=DIM)
    d.text((W - 70, 44), "\u22EE", font=font(36), fill=DIM)

def draw_input(d, text="Message"):
    y0 = H - 110
    d.rectangle([0, y0, W, H], fill=BG)
    # input pill
    rounded(d, [16, y0 + 14, W - 110, y0 + 86], 40, HEADER_BG)
    col = DIM if text == "Message" else TXT
    d.text((48, y0 + 34), text[:42], font=F_INP, fill=col)
    # send/mic button
    d.ellipse([W - 92, y0 + 14, W - 20, y0 + 86], fill=GREEN)
    d.text((W - 72, y0 + 30), "\u27A4" if text != "Message" else "\u25CF",
           font=font(34), fill=(255, 255, 255))

def bubble(d, text, out, y, maxw=560, tick=True):
    fnt = F_MSG
    lines = wrap(d, text, fnt, maxw - 90)
    lh = 42
    bw = max(d.textlength(l, font=fnt) for l in lines) + 56
    bh = len(lines) * lh + 44
    x0 = W - bw - 24 if out else 24
    rounded(d, [x0, y, x0 + bw, y + bh], 22, OUT_BG if out else IN_BG)
    yy = y + 16
    for l in lines:
        d.text((x0 + 28, yy), l, font=fnt, fill=TXT); yy += lh
    # time + ticks
    d.text((x0 + bw - 108, y + bh - 32), "13:42", font=F_TIME, fill=DIM)
    if out and tick:
        d.text((x0 + bw - 52, y + bh - 34), "\u2713\u2713", font=font(22), fill=BLUE_TICK)
    return y + bh + 18

def main():
    cmd, user_text, bot_reply, outdir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    os.makedirs(outdir, exist_ok=True)
    # Timeline (seconds): typing 2.5s, sent hold 1s, bot typing 1.5s, reply hold 3s
    phases = []
    # phase 1: user typing in input bar
    n1 = int(2.5 * FPS)
    for i in range(n1):
        nch = int(len(user_text) * (i + 1) / n1)
        phases.append(("utype", user_text[:nch]))
    # phase 2: user msg sent, hold
    for _ in range(int(1.0 * FPS)): phases.append(("usent", user_text))
    # phase 3: bot typing
    for _ in range(int(1.5 * FPS)): phases.append(("btype", user_text))
    # phase 4: bot reply (reveal progressively)
    n4 = int(1.2 * FPS)
    for i in range(n4):
        frac = (i + 1) / n4
        nch = int(len(bot_reply) * frac)
        phases.append(("breply", bot_reply[:nch]))
    for _ in range(int(2.5 * FPS)): phases.append(("breply", bot_reply))

    for idx, (ph, txt) in enumerate(phases):
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        typing = (ph == "btype")
        draw_header(d, "NEXORA-MD", typing=typing)
        y = 160
        if ph in ("usent", "btype", "breply"):
            y = bubble(d, user_text, True, y)
        if ph == "breply":
            bubble(d, txt, False, y)
        if ph == "btype":
            # typing dots
            bx = 24; by = y
            rounded(d, [bx, by, bx + 120, by + 56], 22, IN_BG)
            dots = int(idx % 3) + 1
            d.text((bx + 30, by + 10), "." * dots + " " * (3 - dots), font=font(36), fill=DIM)
        draw_input(d, txt if ph == "utype" else "Message")
        im.save(os.path.join(outdir, f"f{idx:04d}.png"))
    print(f"frames={len(phases)} -> {outdir}")

main()
