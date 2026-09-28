#!/usr/bin/env python3
"""Verify all demo videos: valid MP4, has video stream, sane duration/size."""
import subprocess, os, sys

BASE = "/home/hatch/workspace/whatsapp-md-bot/demo-gen"
sys.path.insert(0, BASE)
from batch_gen import DEMO_CMDS

bad, ok = [], 0
for cmd in sorted(DEMO_CMDS):
    v = os.path.join(BASE, "videos", "d%s.mp4" % cmd)
    if not os.path.exists(v):
        bad.append((cmd, "missing")); continue
    sz = os.path.getsize(v)
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration:stream=codec_type,width,height",
                        "-of", "csv=p=0", v], capture_output=True, text=True)
    lines = r.stdout.strip().split("\n")
    dur = 0.0
    for l in lines:
        try:
            dur = float(l); break
        except ValueError:
            continue
    has_v = any(l.startswith("video,") for l in lines)
    if r.returncode != 0 or not has_v or not (15 <= dur <= 30) or sz < 20000:
        bad.append((cmd, "dur=%.1f size=%d has_v=%s" % (dur, sz, has_v)))
    else:
        ok += 1
print("VALID %d/%d" % (ok, len(DEMO_CMDS)))
for c, why in bad:
    print("BAD", c, why)
