#!/usr/bin/env python3
"""Batch generate multi-scene demo videos for all NEXORA-MD commands.
Usage: python3 batch_gen.py [start_idx] [end_idx] [workers]
Pipeline: build_specs.py -> render.py (frames) -> ffmpeg (mp4).
These are high-quality SIMULATIONS with real command outputs, not phone recordings.
"""
import sys, os, subprocess
from multiprocessing import Pool

BASE = "/home/hatch/workspace/whatsapp-md-bot/demo-gen"

# Demo set: 118 commands (filenames demo-gen/videos/d<cmd>.mp4)
DEMO_CMDS = ("accounts activity add adminaction ai aichat alive anticall antidelete "
 "antilink antistatus attp autoreact autoread autotyping barcode bassboost beautiful "
 "blocklist botdp botname botstats coin contact country crypto dadjoke dare define "
 "del delpath demote description disconnect dp emojimix emojimix2 fact fb gclose "
 "getbio getpp getprivacy gif glink glow goodbye gopen groupsprivacy hidetag ig "
 "imagine inbox ip iss jail joke kick lyrics meme meme2 menu mode neon owner "
 "owneremojis ownername ownernumber paheli ping play poll prefix promote public "
 "qr qrread quiz quote reactemojis recipe recording rhyme roll say self setgoodbye "
 "setname setonline setppall settings setwelcome shayari ship shorten ss statusview "
 "sticker stickername tagall tempmail tiktok tiktoksearch toimg tomp3 tr trigger "
 "truth updatebio users uwu vcf vote vv vv2 wanted weather welcome").split()

def gen(cmd):
    spec = os.path.join(BASE, "specs", cmd + ".json")
    d = os.path.join(BASE, "frames", cmd)
    v = os.path.join(BASE, "videos", "d%s.mp4" % cmd)
    os.makedirs(os.path.dirname(v), exist_ok=True)
    r = subprocess.run(["python3", os.path.join(BASE, "render.py"), spec, d],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("FAIL render %s: %s" % (cmd, r.stderr[-300:]), flush=True)
        return (cmd, False)
    r = subprocess.run(
        ["ffmpeg", "-y", "-framerate", "10", "-i", os.path.join(d, "f%04d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
         "-movflags", "+faststart", v],
        capture_output=True, text=True)
    subprocess.run(["rm", "-rf", d], capture_output=True)
    if r.returncode != 0:
        print("FAIL ffmpeg %s" % cmd, flush=True)
        return (cmd, False)
    sz = os.path.getsize(v)
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0", v],
                         capture_output=True, text=True).stdout.strip()
    print("OK %s (%dKB, %ss)" % (cmd, sz // 1024, dur), flush=True)
    return (cmd, True)

def main():
    cmds = sorted(DEMO_CMDS)
    s = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    e = int(sys.argv[2]) if len(sys.argv) > 2 else len(cmds)
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    todo = cmds[s:e]
    r = subprocess.run(["python3", os.path.join(BASE, "build_specs.py")],
                       capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print("build_specs FAILED:", r.stderr[-500:])
        return
    with Pool(workers) as p:
        res = p.map(gen, todo)
    ok = sum(1 for _, good in res if good)
    bad = [c for c, good in res if not good]
    print("DONE %d/%d" % (ok, len(todo)))
    if bad:
        print("FAILED:", bad)

if __name__ == "__main__":
    main()
