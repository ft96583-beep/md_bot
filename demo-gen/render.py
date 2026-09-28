#!/usr/bin/env python3
"""Multi-scene demo video renderer for NEXORA-MD .d<cmd> demos.
Usage: python3 render.py spec.json outdir

spec.json fields:
  cmd, desc, owner, admin, example, output_type (text|image|video|location),
  output_text (real bot reply or media caption), media_label, steps[3],
  notes[], time

Scenes @10fps: S1 title 35f | S2 steps 55f | S3 chat demo 95f | S4 notes 40f
Total: 225 frames = 22.5 seconds.

These are high-quality SIMULATIONS with real command outputs, not phone recordings.
"""
import sys, os, json, re
from PIL import Image, ImageDraw, ImageFont

W, H = 720, 1280
FPS = 10
BG      = (11, 20, 26)    # #0b141a WhatsApp dark
HEADER  = (31, 44, 52)    # #1f2c34
OUT_BG  = (0, 92, 75)     # #005c4b outgoing
IN_BG   = (31, 44, 52)    # #1f2c34 incoming
TXT     = (235, 245, 246)
DIM     = (134, 150, 160) # #8696a0
GREEN   = (0, 168, 132)   # #00a884
TICK    = (83, 189, 235)  # #53bdeb blue ticks
TEAL    = (37, 211, 102)  # accent
CARD    = (24, 34, 41)    # #182229 code/media card
GOLD    = (255, 193, 80)

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
DEJAVU_M = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
EMOJI_F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "NotoEmoji.ttf")

_fonts = {}
def font(kind, sz):
    key = (kind, sz)
    if key not in _fonts:
        p = {"reg": DEJAVU, "bold": DEJAVU_B, "mono": DEJAVU_M, "emoji": EMOJI_F}[kind]
        _fonts[key] = ImageFont.truetype(p, sz)
    return _fonts[key]

EMOJI_RE = re.compile(
    '[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE00-\uFE0F\u200D'
    '\u2190-\u21FF\u2300-\u23FF\u25A0-\u25FF\u00A9\u00AE\u2122\u2640\u2642'
    '\u23E9-\u23F3\u23F8-\u23FA\u20E3]+')

def rich_segments(text):
    """Split text into (chunk, bold, is_emoji) runs. *bold* markers consumed."""
    segs = []
    pos = 0
    for m in re.finditer(r'\*([^*]{1,150})\*', text):
        if m.start() > pos:
            segs.extend(_emoji_split(text[pos:m.start()], False))
        segs.extend(_emoji_split(m.group(1), True))
        pos = m.end()
    if pos < len(text):
        segs.extend(_emoji_split(text[pos:], False))
    return [s for s in segs if s[0]]

def _emoji_split(s, bold):
    out, i = [], 0
    for m in EMOJI_RE.finditer(s):
        if m.start() > i:
            out.append((s[i:m.start()], bold, False))
        out.append((m.group(0), bold, True))
        i = m.end()
    if i < len(s):
        out.append((s[i:], bold, False))
    return out

def protect_bold(text):
    """Keep *bold* spans on one wrapped line (nbsp inside spans)."""
    return re.sub(r'\*([^*]{1,150})\*',
                  lambda m: '*' + m.group(1).replace(' ', ' ') + '*', text)

def measure(text, sz):
    w = 0.0
    for chunk, bold, is_emoji in rich_segments(text):
        f = font("emoji" if is_emoji else ("bold" if bold else "reg"), sz)
        w += f.getlength(chunk)
    return w

def draw_rich(d, x, y, text, sz, fill=TXT):
    for chunk, bold, is_emoji in rich_segments(text):
        f = font("emoji" if is_emoji else ("bold" if bold else "reg"), sz)
        d.text((x, y), chunk, font=f, fill=fill)
        x += f.getlength(chunk)
    return x

def wrap_rich(text, maxw, sz):
    lines, cur = [], ""
    for w in text.split(" "):
        t = (cur + " " + w).strip()
        if measure(t, sz) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            while measure(w, sz) > maxw and len(w) > 1:
                k = len(w)
                while k > 1 and measure(w[:k], sz) > maxw:
                    k -= 1
                lines.append(w[:k])
                w = w[k:]
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def clean_output(t, limit=700):
    t = t.replace("\t", " ")
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if len(t) > limit:
        t = t[:limit].rsplit(" ", 1)[0] + "…"
    return t

# ── shared chrome ──────────────────────────────────────────────
def status_bar(d, timestr):
    d.rectangle([0, 0, W, 54], fill=(7, 13, 17))
    d.text((26, 12), timestr, font=font("reg", 25), fill=TXT)
    # signal bars
    bx = W - 148
    for i, h in enumerate([8, 12, 16, 20]):
        d.rectangle([bx + i * 12, 40 - h, bx + i * 12 + 8, 40], fill=TXT)
    # wifi arcs
    cx, cy = W - 84, 44
    for r in (6, 11, 16):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=225, end=315, fill=TXT, width=3)
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=TXT)
    # battery
    d.rounded_rectangle([W - 62, 16, W - 22, 38], radius=6, outline=DIM, width=2)
    d.rectangle([W - 56, 21, W - 56 + 26, 33], fill=GREEN)
    d.rectangle([W - 20, 22, W - 16, 32], fill=DIM)

def header(d, typing=False):
    d.rectangle([0, 54, W, 184], fill=HEADER)
    # back arrow
    d.polygon([(34, 119), (58, 95), (58, 107), (76, 107), (76, 131), (58, 131), (58, 143)], fill=TXT)
    # avatar
    d.ellipse([92, 84, 164, 156], fill=GREEN)
    draw = d
    nm = "N"
    f = font("bold", 40)
    draw.text((128 - f.getlength(nm) / 2, 100), nm, font=f, fill=(255, 255, 255))
    d.text((184, 88), "NEXORA-MD", font=font("bold", 33), fill=TXT)
    d.text((184, 130), "typing..." if typing else "online",
           font=font("reg", 24), fill=GREEN if typing else DIM)
    # video-call icon (drawn) + 3-dot menu
    vx, vy = W - 138, 104
    d.rounded_rectangle([vx, vy, vx + 40, vy + 28], radius=8, outline=DIM, width=3)
    d.polygon([(vx + 40, vy + 4), (vx + 58, vy - 6), (vx + 58, vy + 34),
               (vx + 40, vy + 24)], fill=DIM)
    for i in range(3):
        d.ellipse([W - 62, 102 + i * 16, W - 50, 114 + i * 16], fill=DIM)

_chat_bg = None
def chat_bg():
    global _chat_bg
    if _chat_bg is None:
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        # subtle doodle dots
        import random
        rnd = random.Random(7)
        for _ in range(260):
            x, y = rnd.randint(0, W), rnd.randint(190, 1160)
            r = rnd.randint(2, 5)
            d.ellipse([x - r, y - r, x + r, y + r], fill=(16, 28, 35))
        _chat_bg = im
    return _chat_bg.copy()

def date_chip(d):
    t = "TODAY"
    f = font("reg", 22)
    w = f.getlength(t) + 44
    x0 = (W - w) / 2
    d.rounded_rectangle([x0, 200, x0 + w, 244], radius=14, fill=HEADER)
    d.text((x0 + 22, 210), t, font=f, fill=DIM)

def bubble(d, text, out, y, sz=29, maxw=560, show_meta=True, timestr=""):
    lines = []
    for para in protect_bold(text).split("\n"):
        lines.extend(wrap_rich(para, maxw - 96, sz) or [""])
    lines = lines[:10]
    lh = sz + 15
    bw = max([measure(l, sz) for l in lines] or [0]) + 60
    bh = len(lines) * lh + (52 if show_meta else 34)
    x0 = W - bw - 24 if out else 24
    if y + bh > 1150:  # keep inside chat area; caller should avoid, but clamp
        bh = 1150 - y
    d.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=22, fill=OUT_BG if out else IN_BG)
    yy = y + 16
    for l in lines:
        draw_rich(d, x0 + 30, yy, l, sz)
        yy += lh
    if show_meta:
        mt = timestr or "2:21 pm"
        f = font("reg", 20)
        tw = f.getlength(mt)
        tx = x0 + bw - tw - (64 if out else 30)
        d.text((tx, y + bh - 32), mt, font=f, fill=(160, 175, 180))
        if out:
            d.text((x0 + bw - 52, y + bh - 34), "✓✓", font=font("reg", 22), fill=TICK)
    return y + bh + 18

def media_bubble(d, label, caption, y, timestr=""):
    """Simulated incoming media (photo/video/location) + real caption."""
    bw, bh = 500, 330
    x0 = 24
    d.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=22, fill=CARD)
    d.rounded_rectangle([x0 + 10, y + 10, x0 + bw - 10, y + 236], radius=14, fill=(13, 22, 28))
    draw_rich(d, x0 + bw / 2 - measure(label.split()[0], 84) / 2, y + 70, label.split()[0], 84)
    f = font("reg", 24)
    lab = " ".join(label.split()[1:]) or label
    d.text((x0 + bw / 2 - f.getlength(lab) / 2, y + 180), lab, font=f, fill=DIM)
    yy = y + 252
    for l in (wrap_rich(protect_bold(caption), bw - 70, 27) or [""])[:3]:
        draw_rich(d, x0 + 34, yy, l, 27)
        yy += 40
    return y + bh + 18

def input_bar(d, text=""):
    y0 = H - 112
    d.rectangle([0, y0, W, H], fill=(7, 13, 17))
    d.rounded_rectangle([16, y0 + 14, W - 112, y0 + 88], radius=40, fill=HEADER)
    # emoji + attach glyphs
    d.text((38, y0 + 32), "☺", font=font("reg", 34), fill=DIM)
    if text:
        draw_rich(d, 92, y0 + 34, text[:40], 29)
    else:
        d.text((92, y0 + 36), "Message", font=font("reg", 29), fill=DIM)
    d.text((W - 168, y0 + 34), "📎", font=font("emoji", 30), fill=DIM)
    # mic button
    d.ellipse([W - 94, y0 + 14, W - 22, y0 + 88], fill=GREEN)
    d.text((W - 76, y0 + 28), "🎤", font=font("emoji", 32), fill=(255, 255, 255))

def typing_dots(d, y, frame):
    x0 = 24
    d.rounded_rectangle([x0, y, x0 + 130, y + 60], radius=22, fill=IN_BG)
    n = (frame % 30) // 10 + 1
    for i in range(3):
        cx = x0 + 38 + i * 28
        col = TXT if i < n else (90, 100, 108)
        d.ellipse([cx - 8, y + 22, cx + 8, y + 38], fill=col)

# ── scenes ─────────────────────────────────────────────────────
def scene_title(spec):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    status_bar(d, spec["time"])
    # pill
    pill = "🎬  DEMO VIDEO"
    f = font("bold", 27)
    pw = f.getlength("DEMO VIDEO") + measure("🎬 ", 27) + 70
    x0 = (W - pw) / 2
    d.rounded_rectangle([x0, 300, x0 + pw, 362], radius=31, fill=GREEN)
    draw_rich(d, x0 + 35, 312, pill, 27, fill=(6, 20, 16))
    # command
    cmd = "." + spec["cmd"]
    f = font("bold", 66)
    draw_rich(d, W / 2 - measure(cmd, 66) / 2, 430, cmd, 66)
    # teal divider
    d.rectangle([W / 2 - 120, 540, W / 2 + 120, 546], fill=GREEN)
    # desc
    yy = 590
    for l in (wrap_rich(protect_bold(spec["desc"]), W - 160, 31) or [""])[:3]:
        draw_rich(d, W / 2 - measure(l, 31) / 2, yy, l, 31, fill=(200, 215, 218))
        yy += 52
    # how to get this demo
    yy += 40
    t = "WhatsApp mein  .d%s  likho" % spec["cmd"]
    draw_rich(d, W / 2 - measure(t, 29) / 2, yy, t, 29, fill=DIM)
    # brand footer
    draw_rich(d, W / 2 - measure("NEXORA-MD 💗", 30) / 2, H - 220, "NEXORA-MD 💗", 30)
    return im

def scene_steps(spec):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    status_bar(d, spec["time"])
    draw_rich(d, 40, 130, "📋 Kaise use karein", 37, fill=TXT)
    d.rectangle([40, 190, 300, 196], fill=GREEN)
    layers = []
    yy = 250
    for i, st in enumerate(spec["steps"][:3]):
        lay = im.copy()
        dd = ImageDraw.Draw(lay)
        y2 = 250
        for j in range(i + 1):
            s = spec["steps"][j]
            # number circle
            dd.ellipse([40, y2 + 4, 96, y2 + 60], fill=GREEN)
            num = str(j + 1)
            nf = font("bold", 30)
            dd.text((68 - nf.getlength(num) / 2, y2 + 12), num, font=nf, fill=(6, 20, 16))
            if j == 1:
                # step text then code box with example
                for l in (wrap_rich(protect_bold(s), W - 180, 28) or [""])[:2]:
                    draw_rich(dd, 116, y2, l, 28)
                    y2 += 46
                ex = spec["example"]
                ew = measure(ex, 28) + 56
                dd.rounded_rectangle([116, y2 + 6, 116 + min(ew, W - 160), y2 + 62], radius=14, fill=CARD)
                draw_rich(dd, 144, y2 + 16, ex, 28, fill=TEAL)
                y2 += 96
            else:
                for l in (wrap_rich(protect_bold(s), W - 180, 28) or [""])[:3]:
                    draw_rich(dd, 116, y2, l, 28)
                    y2 += 46
                y2 += 26
        layers.append((lay, y2))
    return layers

def scene_notes(spec):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    status_bar(d, spec["time"])
    draw_rich(d, 40, 130, "⚠️ Zaroori baatein", 37)
    d.rectangle([40, 190, 300, 196], fill=GREEN)
    yy = 250
    for n in spec["notes"][:5]:
        d.ellipse([48, yy + 8, 66, yy + 26], fill=TEAL)
        for l in (wrap_rich(protect_bold(n), W - 170, 28) or [""])[:3]:
            draw_rich(d, 92, yy, l, 28)
            yy += 46
        yy += 22
    # footer pill
    t = "🎬  .d%s likh kar ye demo dobara dekho" % spec["cmd"]
    f = font("reg", 26)
    pw = measure(t, 26) + 70
    x0 = (W - pw) / 2
    d.rounded_rectangle([x0, H - 260, x0 + pw, H - 196], radius=32, fill=HEADER)
    draw_rich(d, x0 + 35, H - 244, t, 26)
    return im

MEDIA_GLYPH = {"image": "🖼️", "video": "🎬", "location": "📍"}
MEDIA_WORD = {"image": "Photo aayi", "video": "Video aayi", "location": "Location aayi"}

def chat_frame(spec, phase, txt, frame_idx):
    im = chat_bg()
    d = ImageDraw.Draw(im)
    status_bar(d, spec["time"])
    typing = phase == "btype"
    header(d, typing=typing)
    date_chip(d)
    y = 268
    if phase in ("usent", "btype", "breply"):
        y = bubble(d, spec["example"], True, y, timestr=spec["time"])
    if phase == "breply":
        ot = spec["output_type"]
        if ot == "text":
            bubble(d, txt, False, y, timestr=spec["time"])
        else:
            media_bubble(d, MEDIA_GLYPH[ot] + " " + MEDIA_WORD[ot],
                         clean_output(txt, 220), y, timestr=spec["time"])
    elif phase == "btype":
        typing_dots(d, y, frame_idx)
    input_bar(d, txt if phase == "utype" else "")
    return im

def fade_frames(im, n=10):
    base = Image.new("RGB", (W, H), BG)
    return [Image.blend(base, im, (i + 1) / n) for i in range(n)]

def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    frames = []

    # S1 title (35f, fade in)
    s1 = scene_title(spec)
    frames.extend(fade_frames(s1, 10))
    frames.extend([s1] * 25)

    # S2 steps (55f, progressive)
    layers = scene_steps(spec)
    counts = [12, 18, 25]
    for lay, cnt in zip(layers, counts):
        frames.extend([lay[0]] * cnt)

    # S3 chat demo (95f)
    ex, full = spec["example"], clean_output(spec["output_text"])
    tl = []
    n1 = 20
    for i in range(n1):
        tl.append(("utype", ex[: int(len(ex) * (i + 1) / n1)]))
    tl.extend([("usent", ex)] * 10)
    tl.extend([("btype", ex)] * 15)
    n4 = 15
    for i in range(n4):
        tl.append(("breply", full[: int(len(full) * (i + 1) / n4)]))
    tl.extend([("breply", full)] * 35)
    for fi, (ph, t) in enumerate(tl):
        frames.append(chat_frame(spec, ph, t, fi))

    # S4 notes (40f, fade in)
    s4 = scene_notes(spec)
    frames.extend(fade_frames(s4, 10))
    frames.extend([s4] * 30)

    for i, im in enumerate(frames):
        im.save(os.path.join(outdir, "f%04d.png" % i))
    print("frames=%d -> %s" % (len(frames), outdir))

main()
