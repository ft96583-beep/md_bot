#!/usr/bin/env python3
"""Build per-command demo specs (JSON) from real test results + curated examples.
Usage: python3 build_specs.py
Writes demo-gen/specs/<cmd>.json for every command in the demo set.
"""
import json, os, sys, re
from datetime import datetime, timedelta, timezone

BASE = "/home/hatch/workspace/whatsapp-md-bot/demo-gen"
sys.path.insert(0, BASE)
from batch_gen import DEMO_CMDS  # noqa: E402  (demo set = 118 commands)

TESTS = {r["name"]: r for r in json.load(open("/tmp/command_test_results.json", encoding="utf-8"))}

# Commands with no test data (not in registry either — orphan demo videos)
NO_TEST = {
    "trigger":   ("Photo par *triggered* effect lagao", "Jis photo par effect lagana hai, us par *reply* karo", ".trigger", "⚡ Triggered effect lag raha hai..."),
    "beautiful": ("Photo par *beautiful* frame lagao", "Jis photo par frame lagana hai, us par *reply* karo", ".beautiful", "✨ Beautiful frame ban raha hai..."),
    "jail":      ("Photo par *jail* effect lagao", "Jis photo par effect lagana hai, us par *reply* karo", ".jail", "🔒 Jail effect lag raha hai..."),
    "meme2":     ("Meme banao (doosra style)", None, ".meme upar wala | neeche wala", "😂 Meme ban raha hai..."),
    "emojimix2": ("Do emoji mix karke sticker banao", None, ".emojimix 😂❤️", "🧪 Emoji mix ho raha hai..."),
}

# Realistic example inputs: what the user types in the demo chat
EXAMPLES = {
    "menu": ".menu", "ping": ".ping", "alive": ".alive", "botstats": ".botstats",
    "owner": ".owner", "accounts": ".accounts", "disconnect": ".disconnect 923492372653",
    "autoreact": ".autoreact on", "autoread": ".autoread on", "autotyping": ".autotyping off",
    "tiktok": ".tiktok https://www.tiktok.com/@funny/video/7123456789012345678",
    "ig": ".ig https://www.instagram.com/reel/DBxYz12345ab/",
    "fb": ".fb https://www.facebook.com/reel/987654321012345/",
    "sticker": ".sticker", "toimg": ".toimg", "attp": ".attp NEXORA",
    "meme": ".meme Kaam | Jaldi karo | Phir chai piyo",
    "ss": ".ss google.com", "emojimix": ".emojimix 😂❤️",
    "tagall": ".tagall Meeting 5 baje hai!", "hidetag": ".hidetag Salam sab ko!",
    "kick": ".kick @0321xxxxxxx", "add": ".add 923001234567",
    "promote": ".promote @0321xxxxxxx", "demote": ".demote @0321xxxxxxx",
    "gclose": ".gclose", "gopen": ".gopen", "glink": ".glink", "del": ".del",
    "welcome": ".welcome on", "goodbye": ".goodbye on",
    "setwelcome": ".setwelcome Khush amdeed! 🌸",
    "setgoodbye": ".setgoodbye Allah Hafiz! 👋",
    "antilink": ".antilink on", "antidelete": ".antidelete on",
    "antistatus": ".antistatus on", "anticall": ".anticall on",
    "ai": ".ai Assalam o Alaikum, tum kaun ho?",
    "aichat": ".aichat on", "imagine": ".imagine Pyari si billi, chandni raat",
    "lyrics": ".lyrics Moye Moye", "play": ".play Moye Moye",
    "tomp3": ".tomp3", "shayari": ".shayari", "joke": ".joke", "fact": ".fact",
    "quote": ".quote", "truth": ".truth", "dare": ".dare", "quiz": ".quiz",
    "paheli": ".paheli", "rhyme": ".rhyme dil", "ship": ".ship Ali | Sana",
    "wanted": ".wanted", "coin": ".coin", "roll": ".roll",
    "dadjoke": ".dadjoke", "gif": ".gif", "stickername": ".stickername Nexa | NEXORA-MD",
    "neon": ".neon NEXORA", "glow": ".glow Boss",
    "barcode": ".barcode 923448072653", "qr": ".qr Assalam o Alaikum",
    "qrread": ".qrread", "shorten": ".shorten https://www.youtube.com/watch?v=abc123",
    "tempmail": ".tempmail", "ip": ".ip 8.8.8.8",
    "weather": ".weather Lahore", "country": ".country Pakistan",
    "crypto": ".crypto BTC", "define": ".define mohabbat",
    "tr": ".tr Assalam o Alaikum", "say": ".say Assalam o Alaikum Boss!",
    "bassboost": ".bassboost", "vote": ".vote Chai ya Coffee?",
    "poll": ".poll Best colour? | Red | Blue | Green",
    "blocklist": ".blocklist", "description": ".description NEXORA family group 💗",
    "getpp": ".getpp", "getbio": ".getbio",
    "getprivacy": ".getprivacy", "groupsprivacy": ".groupsprivacy everyone",
    "statusview": ".statusview on", "inbox": ".inbox",
    "vcf": ".vcf", "users": ".users", "activity": ".activity",
    "settings": ".settings", "mode": ".mode self", "public": ".public",
    "self": ".self", "prefix": ".prefix !", "botname": ".botname NEXORA-MD",
    "botdp": ".botdp", "ownername": ".ownername Boss",
    "ownernumber": ".ownernumber", "owneremojis": ".owneremojis 👑💗",
    "reactemojis": ".reactemojis 💗🔥", "setppall": ".setppall",
    "setname": ".setname NEXORA-MD", "setonline": ".setonline on",
    "recording": ".recording on", "updatebio": ".updatebio NEXORA-MD 💗",
    "delpath": ".delpath", "adminaction": ".adminaction",
    "vv": ".vv", "vv2": ".vv2",
    "tiktoksearch": ".tiktoksearch funny cats", "uwu": ".uwu Assalam o Alaikum",
    "dp": ".dp", "iss": ".iss", "recipe": ".recipe Chicken Biryani",
    "contact": ".contact Assalam o Alaikum! Mujhe apna bot chahiye",
    "trigger": ".trigger", "beautiful": ".beautiful", "jail": ".jail",
    "meme2": ".meme Upar wala | Neeche wala", "emojimix2": ".emojimix 😂❤️",
}

# Step 1 overrides: reply/context based commands
STEP1 = {
    "sticker": "Jis *photo* par sticker banana hai, us message par *reply* karo",
    "toimg": "Jis *sticker* ko photo banana hai, us par *reply* karo",
    "attp": "NEXORA-MD wali chat kholo 💬",
    "bassboost": "Kisi *voice note* ya audio par *reply* karo 🎧",
    "tomp3": "Kisi *video* ya audio message par *reply* karo",
    "del": "Jis message ko delete karna hai, us par *reply* karo",
    "gif": "Kisi *video* par *reply* karo 🎞️",
    "qrread": "Kisi *QR wali photo* par *reply* karo",
    "getbio": "Kisi ke message par *reply* karo (ya number likho)",
    "getpp": "Kisi ke message par *reply* karo (ya number likho)",
    "wanted": "Jis photo par WANTED poster banana hai, us par *reply* karo 🤠",
    "vv": "Koi *view-once* photo/video kholo 👁️",
    "vv2": "Koi *view-once* photo/video kholo 👁️",
    "setppall": "Koi *photo* bhejo aur us par *reply* karo",
    "botdp": "Koi *photo* bhejo aur us par *reply* karo",
    "8d": "Kisi *voice note* ya audio par *reply* karo 🎧",
    "kick": "Group kholo — member ko *tag* karo ya uske message par reply karo",
    "promote": "Group kholo — member ko *tag* karo ya uske message par reply karo",
    "demote": "Group kholo — member ko *tag* karo ya uske message par reply karo",
    "add": "Group kholo — number *country code* ke saath likho",
    "tagall": "Bot jis *group* mein hai, wahan jao 👥",
    "hidetag": "Bot jis *group* mein hai, wahan jao 👥",
    "gclose": "Bot jis *group* mein hai, wahan jao 👥",
    "gopen": "Bot jis *group* mein hai, wahan jao 👥",
    "glink": "Bot jis *group* mein hai, wahan jao 👥",
    "del": "Jis message ko delete karna hai, us par *reply* karo",
    "welcome": "Bot jis *group* mein hai, wahan jao 👥",
    "goodbye": "Bot jis *group* mein hai, wahan jao 👥",
    "setwelcome": "Bot jis *group* mein hai, wahan jao 👥",
    "setgoodbye": "Bot jis *group* mein hai, wahan jao 👥",
    "vcf": "Bot jis *group* mein hai, wahan jao 👥",
    "description": "Bot jis *group* mein hai, wahan jao 👥",
    "trigger": "Jis photo par effect lagana hai, us par *reply* karo",
    "beautiful": "Jis photo par frame lagana hai, us par *reply* karo",
    "jail": "Jis photo par effect lagana hai, us par *reply* karo",
}
DEFAULT_STEP1 = "NEXORA-MD wali chat kholo 💬"

def clean(t, limit=650):
    t = t.replace("\t", " ")
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if len(t) > limit:
        t = t[:limit].rsplit(" ", 1)[0] + "…"
    return t

def build(cmd):
    r = TESTS.get(cmd)
    if r:
        desc = r["desc"]
        owner, admin = r["owner"], r["admin"]
        status = r["status"]
        outs = r.get("outputs", [])
        if outs:
            c = outs[0]["content"]
            otype = c.get("type", "text")
            otext = c.get("text") or c.get("caption") or ""
        else:
            otype, otext = "text", ""
    else:
        desc, _, _, otext = NO_TEST[cmd]
        owner, admin, status, otype = False, False, "ok", "text"

    example = EXAMPLES.get(cmd, "." + cmd)
    otext = clean(otext)

    # Special-case overrides with REAL documented behaviour
    notes = []
    if cmd == "contact":
        otext = ("✅ Paigham owner tak pahunch gaya!\nJawab aapke inbox mein aayega 💗")
        notes = [
            "📩 Tumhara paigham seedha *private Owner Panel* mein jata hai",
            "🤫 Owner ki identity aur number *chhupay* rehte hain",
            "👑 Owner panel se jawab dega",
            "💗 Tumhein milega: *👑 Owner ka jawab 💗*",
        ]
    elif cmd == "vv":
        notes = [
            "👁️ Kisi *view-once* photo/video/voice ke *reply* mein likho",
            "💬 Seedha *sticker* ya koi *word* se reply par bhi auto yourself mein jata hai",
            "✨ *.vv s* = photo ka *sticker* bana kar bhejta hai",
        ]
    elif cmd == "vv2":
        notes = [
            "👁️ View-once ke *reply* mein likho — jaise .vv",
            "📩 Media owner ke *private inbox* mein jata hai",
        ]
    elif cmd in ("gclose", "gopen", "glink", "hidetag", "tagall"):
        otext = ("👥 Ye command sirf *group* mein chalti hai\n"
                 "🛡️ Tumhein aur *bot ko* dono ko admin hona chahiye\n"
                 "⚡ Group mein bhejo — bot foran action lega")
        notes = [
            "👥 Ye command sirf *group* mein kaam karti hai",
            "🛡️ Tumhein aur *bot ko* dono ko admin hona zaroori hai",
            "💡 Demo chat mein nahi — asal group mein try karo",
        ]
    elif cmd == "song":
        otext = "🎵 YouTube se dhoond rahi hoon..."
        notes = [
            "⏳ YouTube se download mein *1-2 minute* lag sakte hain",
            "🎵 Pehle yehi reply aata hai, phir gaana milta hai",
        ]
    else:
        if owner:
            notes.append("👑 Sirf *owner* (Boss) ye command chala sakta hai")
        if admin:
            notes.append("🛡️ Is ke liye *group admin* hona zaroori hai")
        if otype in ("image", "video"):
            notes.append("🖼️ Jawab mein *photo/video* aayegi")
        if otype == "location":
            notes.append("📍 Jawab mein *location* aayegi")
        if cmd == "menu":
            notes.append("📜 Poori command list *tasveer* mein aayegi")
        if cmd == "tempmail":
            notes.append("📧 Pehle *.tempmail* se address banao, phir *.inbox* dekho")
        if cmd == "inbox":
            notes.append("📧 Pehle *.tempmail* se address banana zaroori hai")
        if cmd in ("tiktok", "ig", "fb", "play", "ss", "imagine"):
            notes.append("⏳ Download mein thoda *waqt* lag sakta hai — sabar rakho")
        if cmd in NO_TEST:
            notes.append("🎨 Media wali command hai — reply karke chalao")

    if cmd not in ("contact", "vv", "vv2") and not (cmd in ("gclose", "gopen", "glink", "hidetag", "tagall")):
        notes.append("🎬 *.d%s* likh kar ye demo kabhi bhi dobara dekho" % cmd)

    # Steps
    s1 = STEP1.get(cmd, DEFAULT_STEP1)
    s2 = "Neeche wala message likho aur *bhejo* ➤"
    if otext.startswith("❌"):
        s3 = "Kuch ghalat ho to bot *sahi tareeqa* khud batayega 💡"
    elif cmd in ("gclose", "gopen", "glink", "hidetag", "tagall"):
        s3 = "Bot foran action lega — koi lamba intezar nahi ⚡"
    else:
        s3 = "Agla scene dekho — *asli* demo mein bot ka jawab 👇"

    if cmd == "contact":
        s1 = "NEXORA-MD wali chat kholo (koi bhi number) 💬"
        s2 = "Apna paigham likho aur *bhejo* ➤"
        s3 = "Jawab tumhare *inbox* mein aayega — intezar karo 💗"

    spec = {
        "cmd": cmd,
        "desc": desc,
        "owner": owner,
        "admin": admin,
        "example": example,
        "output_type": otype,
        "output_text": otext,
        "steps": [s1, s2, s3],
        "notes": notes[:5],
        "time": (datetime.now(timezone.utc) + timedelta(hours=5)).strftime("%-I:%M %p").lower(),
    }
    return spec

def main():
    os.makedirs(os.path.join(BASE, "specs"), exist_ok=True)
    n = 0
    for cmd in DEMO_CMDS:
        spec = build(cmd)
        with open(os.path.join(BASE, "specs", cmd + ".json"), "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False, indent=1)
        n += 1
    print("specs written:", n)

if __name__ == "__main__":
    main()
