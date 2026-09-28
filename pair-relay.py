#!/usr/bin/env python3
"""BOXXAXMD pairing relay worker.

Listens on public Nostr relays for pairing-code requests coming from the
public pairing page, forwards them to the bot's LOCAL /api/pair endpoint,
and publishes the code back over Nostr.

The bot itself stays fully private — only OUTBOUND connections are used
(same proven pattern as the AllVid/ApkForge Nostr workers). No tunnel,
no inbound port, no account needed.

Nostr tags used:
  requests:  kind 1, ["t", "boxxaxmd-pair-req"],
             content {"id": reqid, "number": "923001234567"}
  responses: kind 1, ["t", "boxxaxmd-pair-res"],
             content {"id": reqid, "code": "ABCD-1234", "reused": false, "expiresIn": 75}
             or {"id": reqid, "error": "..."}
             or {"id": reqid, "alreadyConnected": true, ...}

Security notes:
  - Open pairing (Boss ka hukm 2026-09-21): /api/pair par koi owner-number
    lock nahi — jo number page par dega, bot usi se pair hoga.
  - The full phone number is never logged (only first 4 digits + ***).
  - Request ids are deduplicated; each request is handled in its own thread.
"""
import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.request

import websocket
from coincurve import PrivateKey

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, "workspace", "whatsapp-md-bot")
KEY_FILE = os.path.join(BASE, "pair_nostr_key.txt")
LOG_FILE = os.path.join(BASE, "pair-relay.log")
DEMO_FILE = os.path.join(BASE, "demo-links.json")
AUTH_FILE = os.path.join(BASE, "pair-auth.json")
SECRET_FILE = os.path.join(BASE, ".demo-secret")
DEMO_WINDOW_SEC = 300  # 5 minute — Node (lib/pair-auth.js) ke saath EXACT match

_SECRET = None


def _get_secret():
    # .demo-secret ke RAW bytes — Node bhi EXACTLY yahi parhta hai.
    # KABHI regenerate/overwrite mat karna.
    global _SECRET
    if _SECRET is None:
        with open(SECRET_FILE, "rb") as f:
            _SECRET = f.read()
    return _SECRET


def _demo_password_for_window(win):
    mac = hmac.new(_get_secret(),
                   ("nexora-demo-v1:%d" % win).encode("utf8"),
                   hashlib.sha256).digest()
    n = int.from_bytes(mac[0:4], "big") % 1000000
    return "%06d" % n


def _demo_password_ok(pw):
    p = str(pw or "").strip()
    if not re.fullmatch(r"\d{6}", p):
        return False
    win = int(time.time()) // DEMO_WINDOW_SEC
    cur = _demo_password_for_window(win)
    prev = _demo_password_for_window(win - 1)
    return hmac.compare_digest(p, cur) or hmac.compare_digest(p, prev)


def _load_auth():
    try:
        with open(AUTH_FILE) as f:
            o = json.load(f)
        if not isinstance(o, dict):
            return {"permPassword": "", "demo": {}, "perm": {}}
        if not isinstance(o.get("permPassword"), str):
            o["permPassword"] = ""
        if not isinstance(o.get("demo"), dict):
            o["demo"] = {}
        if not isinstance(o.get("perm"), dict):
            o["perm"] = {}
        return o
    except Exception as e:
        log("pair-auth.json read failed: %s" % str(e)[:80])
        return {"permPassword": "", "demo": {}, "perm": {}}


def validate_pair_auth(mode, password, number):
    """Naya password flow. (ok, msg) return karta hai."""
    digits = re.sub(r"\D", "", str(number or ""))
    if not (10 <= len(digits) <= 15):
        return False, "Sahi WhatsApp number likhein (country code ke saath)."
    auth = _load_auth()
    if mode == "demo":
        if not _demo_password_ok(password):
            return False, "❌ Demo password ghalat hai. Owner se maujooda password lein."
        e = auth["demo"].get(digits)
        if not isinstance(e, dict) or e.get("status") != "active":
            return False, "❌ Ye number demo ke liye authorized nahi. Owner se rabta karein."
        return True, ""
    if mode == "perm":
        stored = auth.get("permPassword") or ""
        p = str(password or "")
        if not stored:
            return False, "❌ Permanent password abhi set nahi hua. Owner se rabta karein."
        if not hmac.compare_digest(p, stored):
            return False, "❌ Permanent password ghalat hai."
        e = auth["perm"].get(digits)
        if not isinstance(e, dict) or e.get("status") != "active":
            return False, "❌ Ye number permanent access ke liye authorized nahi. Owner se rabta karein."
        return True, ""
    return False, "Ghalat mode."


def load_demo_links():
    try:
        with open(DEMO_FILE) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            log("demo-links.json malformed (not a dict)")
            return {}
        return data
    except FileNotFoundError:
        return {}
    except Exception as e:
        log("demo-links.json read failed: %s" % str(e)[:80])
        return {}


def validate_demo_token(token, number, requested_kind):
    """Demo/perma token validate karo. (ok, msg) return karta hai."""
    if requested_kind not in ("demo", "perm"):
        return False, "Invalid access link. Please use the link you received."
    if not token:
        return False, "Invalid access link. Please use the link you received."
    links = load_demo_links()
    entry = links.get(token)
    if not entry or not isinstance(entry, dict):
        return False, "This access link is invalid or has been removed."
    if entry.get("status") != "active":
        return False, "This access link is no longer active."
    # kind matching: demo link sirf demo ke liye, perma link sirf perma ke liye
    if entry.get("type") != requested_kind:
        return False, "This access link is invalid or has been removed."
    if requested_kind == "demo" and entry.get("expiresAt") and time.time() * 1000 > entry["expiresAt"]:
        return False, "Your trial period has ended."
    # lockedNumber enforce: sirf assigned number pair ho sakta hai
    locked = entry.get("lockedNumber")
    if locked and re.sub(r"\D", "", str(locked)) != number:
        return False, "This link is assigned to a different number."
    return True, ""


RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
]
REQ_TAG = "boxxaxmd-pair-req"
RES_TAG = "boxxaxmd-pair-res"

PAIR_URL = "http://127.0.0.1:3000/api/pair"
ALIVE_URL = "http://127.0.0.1:3000/api/pair-alive"
WARMUP_URL = "http://127.0.0.1:3000/api/warmup"
PAIR_TIMEOUT = 175  # bot: worker spawn + 25s waitForOpen + 30s stability gate + margin (multi-session)
QR_URL = "http://127.0.0.1:3000/api/qr"
QR_TIMEOUT = 60  # bot: 25s waitForOpen + 20s QR wait + margin

conns = {}          # relay url -> websocket (for publishing)
conns_lock = threading.Lock()
seen_events = set()
done_reqs = set()
state_lock = threading.Lock()


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def mask(num):
    return (num[:4] + "***") if num else "?"


def get_key():
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE) as f:
            return f.read().strip()
    sk = PrivateKey().to_hex()
    with open(KEY_FILE, "w") as f:
        f.write(sk)
    os.chmod(KEY_FILE, 0o600)
    return sk


SK = get_key()
PK_XONLY = PrivateKey.from_hex(SK).public_key.format(compressed=True)[1:].hex()


def sign_event(content, tags):
    created = int(time.time())
    core = [0, PK_XONLY, created, 1, tags, content]
    eid = hashlib.sha256(
        json.dumps(core, separators=(",", ":")).encode()).hexdigest()
    sig = PrivateKey.from_hex(SK).sign_schnorr(bytes.fromhex(eid)).hex()
    return {"id": eid, "pubkey": PK_XONLY, "created_at": created, "kind": 1,
            "tags": tags, "content": content, "sig": sig}


def publish(payload):
    evt = sign_event(json.dumps(payload, separators=(",", ":")),
                     [["t", RES_TAG]])
    msg = json.dumps(["EVENT", evt])
    with conns_lock:
        targets = list(conns.items())
    for url, ws in targets:
        try:
            ws.send(msg)
        except Exception:
            pass


def call_pair_api(number):
    """POST the local /api/pair. Returns (ok, dict)."""
    body = json.dumps({"number": number}).encode()
    req = urllib.request.Request(
        PAIR_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=PAIR_TIMEOUT) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return False, json.loads(e.read().decode())
        except Exception:
            return False, {"error": "server error %s" % e.code}
    except Exception as e:
        return False, {"error": "bot se rabta nahi ho saka"}


def call_qr_api():
    """GET the local /api/qr. Returns (ok, dict)."""
    try:
        with urllib.request.urlopen(QR_URL, timeout=QR_TIMEOUT) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return False, json.loads(e.read().decode())
        except Exception:
            return False, {"error": "server error %s" % e.code}
    except Exception:
        return False, {"error": "bot se rabta nahi ho saka"}


def handle_qr(req_id):
    log("qr request %s" % req_id[:8])
    ok, data = call_qr_api()
    out = {"id": req_id}
    if ok and data.get("qr"):
        out.update(qr=data["qr"], expiresIn=data.get("expiresIn", 20))
        log("qr issued %s" % req_id[:8])
    elif ok and data.get("alreadyConnected"):
        out.update(alreadyConnected=True)
        log("already connected %s" % req_id[:8])
    else:
        out["error"] = data.get("error") or "QR nahi mil saka"
        log("qr failed %s: %s" % (req_id[:8], out["error"][:60]))
    publish(out)


def handle_request(req_id, number, token="", kind="", mode="", password=""):
    log("pair request %s number=%s token=%s kind=%s mode=%s"
        % (req_id[:8], mask(number), "yes" if token else "no", kind or "-", mode or "-"))
    out = {"id": req_id}
    # ── Naya password flow (bina token ke) ──
    if mode and not token and not kind:
        ok, msg = validate_pair_auth(mode, password, number)
        if not ok:
            out["error"] = msg
            log("pair auth rejected %s: %s" % (req_id[:8], msg[:50]))
            publish(out)
            return
    # ── Legacy token flow (?demo=TOKEN / ?perm=TOKEN) — naya flow prove hone tak ──
    elif token or kind:
        ok, msg = validate_demo_token(token, number, kind)
        if not ok:
            out["error"] = msg
            log("pair token rejected %s: %s" % (req_id[:8], msg[:50]))
            publish(out)
            return
    else:
        out["error"] = "Invalid access link. Please use the link you received."
        log("pair rejected %s: no auth" % req_id[:8])
        publish(out)
        return
    ok, data = call_pair_api(number)
    out = {"id": req_id}
    if ok and data.get("code"):
        out.update(code=data["code"], reused=bool(data.get("reused")),
                   expiresIn=data.get("expiresIn", 75))
        log("pair code issued %s reused=%s" % (req_id[:8], out["reused"]))
    elif ok and data.get("alreadyConnected"):
        out.update(alreadyConnected=True)
        log("already connected %s" % req_id[:8])
    else:
        out["error"] = data.get("error") or "code nahi mil saka"
        if "cooldownSeconds" in data:
            out["cooldownSeconds"] = data["cooldownSeconds"]
        log("pair failed %s: %s" % (req_id[:8], out["error"][:60]))
    publish(out)


def handle_warmup(req_id, number, mode="", password="", token="", kind=""):
    """Naye number ka worker pehle se spawn karwao — socket background mein
    connect hota rahe, taake asal code request par koi intezar na ho.
    Warmup bhi password/token auth ke BAGHAIR nahi — warna koi bhi worker spawn karwa sakta hai."""
    log("warmup %s number=%s mode=%s" % (req_id[:8], mask(number), mode or "-"))
    out = {"id": req_id}
    # ── Auth lazmi (naya password flow ya legacy token flow) ──
    if mode and not token and not kind:
        ok, msg = validate_pair_auth(mode, password, number)
    elif token or kind:
        ok, msg = validate_demo_token(token, number, kind)
    else:
        ok, msg = False, "Invalid access link."
    if not ok:
        out["warming"] = False
        out["error"] = msg
        log("warmup rejected %s: %s" % (req_id[:8], msg[:50]))
        publish(out)
        return
    body = json.dumps({"number": number}).encode()
    req = urllib.request.Request(
        WARMUP_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode())
        out = {"id": req_id, "warming": True,
               "ready": bool(data.get("ready"))}
        log("warmup ok %s ready=%s" % (req_id[:8], out["ready"]))
    except Exception as e:
        out = {"id": req_id, "warming": False}
        log("warmup fail %s: %s" % (req_id[:8], str(e)[:50]))
    publish(out)


def handle_alive(req_id, number, mode="", password="", token="", kind=""):
    """Page har 8s poochta hai: code abhi valid hai ya mar gaya?
    Auth warmup jaisi hi (password/token lazmi) — bina auth koi status nahi."""
    out = {"id": req_id}
    if mode and not token and not kind:
        ok, msg = validate_pair_auth(mode, password, number)
    elif token or kind:
        ok, msg = validate_demo_token(token, number, kind)
    else:
        ok, msg = False, "Invalid access link."
    if not ok:
        out["alive"] = False
        out["registered"] = False
        out["error"] = msg
        publish(out)
        return
    try:
        with urllib.request.urlopen(ALIVE_URL + "?number=" + urllib.parse.quote(number),
                                    timeout=15) as r:
            data = json.loads(r.read().decode())
        out = {"id": req_id, "alive": bool(data.get("alive")),
               "registered": bool(data.get("registered"))}
    except Exception as e:
        out = {"id": req_id, "alive": False, "registered": False}
        log("alive fail %s: %s" % (req_id[:8], str(e)[:50]))
    publish(out)


def has_req_tag(tags):
    return any(isinstance(t, list) and len(t) > 1 and t[0] == "t" and t[1] == REQ_TAG
               for t in (tags or []))


def listener(url):
    sub_id = "bxr" + os.urandom(4).hex()
    while True:
        try:
            ws = websocket.create_connection(url, timeout=20)
            ws.settimeout(90)
            with conns_lock:
                conns[url] = ws
            since = int(time.time()) - 600
            ws.send(json.dumps(
                ["REQ", sub_id, {"kinds": [1], "#t": [REQ_TAG], "since": since}]))
            log("listening on %s" % url)
            while True:
                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    try:
                        ws.ping()
                    except Exception:
                        break
                    continue
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if not (isinstance(m, list) and len(m) >= 3 and m[0] == "EVENT"):
                    continue
                evt = m[2]
                eid = evt.get("id", "")
                with state_lock:
                    if eid in seen_events:
                        continue
                    seen_events.add(eid)
                    if len(seen_events) > 2000:
                        seen_events.clear()
                if not has_req_tag(evt.get("tags")):
                    continue
                try:
                    c = json.loads(evt.get("content", "{}"))
                except Exception:
                    continue
                req_id = str(c.get("id", ""))
                action = str(c.get("action", "code"))
                number = re.sub(r"\D", "", str(c.get("number", "")))
                token = str(c.get("token", "") or "")
                kind = str(c.get("kind", "") or "")
                mode = str(c.get("mode", "") or "").lower()  # 'demo' | 'perm' (naya flow)
                password = str(c.get("password", "") or "")  # kabhi log mat karna
                if not re.fullmatch(r"[0-9a-f]{8,64}", req_id):
                    continue
                if action == "qr":
                    pass  # QR mein number nahi chahiye — jo scan kare wahi link hoga
                elif not (10 <= len(number) <= 15):
                    continue
                with state_lock:
                    if req_id in done_reqs:
                        continue
                    done_reqs.add(req_id)
                    if len(done_reqs) > 500:
                        done_reqs.clear()
                if action == "qr":
                    threading.Thread(target=handle_qr,
                                     args=(req_id,), daemon=True).start()
                elif action == "warmup":
                    threading.Thread(target=handle_warmup,
                                     args=(req_id, number, mode, password, token, kind),
                                     daemon=True).start()
                elif action == "alive":
                    threading.Thread(target=handle_alive,
                                     args=(req_id, number, mode, password, token, kind),
                                     daemon=True).start()
                else:
                    threading.Thread(target=handle_request,
                                     args=(req_id, number, token, kind, mode, password),
                                     daemon=True).start()
        except Exception as e:
            log("relay %s down (%s), retry in 5s" % (url, str(e)[:60]))
        with conns_lock:
            conns.pop(url, None)
        time.sleep(5)


def _singleton_or_exit():
    import fcntl
    lock_path = os.path.join(BASE, "pair-relay.lock")
    fh = open(lock_path, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os._exit(0)
    fh.write(str(os.getpid()))
    fh.flush()
    return fh

_LOCK_FH = None

def main():
    global _LOCK_FH
    _LOCK_FH = _singleton_or_exit()
    log("pair-relay worker starting. PUBKEY=%s" % PK_XONLY)
    for url in RELAYS:
        threading.Thread(target=listener, args=(url,), daemon=True).start()
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
