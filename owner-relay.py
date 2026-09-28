#!/usr/bin/env python3
"""NEXORA-MD Owner Panel relay worker.

Public static Owner Panel page (surge.sh) se encrypted requests Nostr relays
par aati hain; ye worker unhein decrypt karke bot ke LOCAL /api/owner/*
endpoints par forward karta hai aur jawab encrypt karke wapas publish karta hai.

Bot khud fully private rehta hai — sirf OUTBOUND connections (pair-relay.py
wala proven pattern). Koi tunnel, koi inbound port nahi.

Crypto (panel ke JS ke saath shared):
  secret      32 random bytes → base64, ~/.owner-panel-secret (chmod 600).
              Boss panel mein ek baar paste karta hai (localStorage).
  envelope    base64( nonce(16) || mac(32) || ciphertext )
  key         SHA256(secret || nonce)
  keystream   SHA256(key || counter_be32) counter-mode, XOR
  mac         SHA256(key || ciphertext) — compare_digest se verify
  payload     {"id","ts","action","params"} / response {"id","ok",...}

Replay protection: nonce dobara nahi chalega (seen set, 15 min TTL),
ts ka skew ±5 min se zyada nahi. Duplicate action ids (reply/disconnect)
dobara action nahi karte — done_ids file mein persist hote hain.

Nostr tags:
  requests:  kind 1, ["t", "nexora-panel-req"], content = envelope (base64 str)
  responses: kind 1, ["t", "nexora-panel-res"], content = envelope (base64 str)
"""

import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import websocket
from coincurve import PrivateKey

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, "workspace", "whatsapp-md-bot")
SECRET_FILE = os.path.join(HOME, ".owner-panel-secret")
TOKEN_FILE = os.path.join(BASE, ".internal_token")
LOG_FILE = os.path.join(BASE, "owner-relay.log")
SEEN_FILE = os.path.join(BASE, "owner-relay-seen.json")
KEY_FILE = os.path.join(BASE, "owner_nostr_key.txt")

RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
]
REQ_TAG = "nexora-panel-req"
RES_TAG = "nexora-panel-res"
PUSH_TAG = "nexora-panel-push"   # 📣 bot → panel push notifications (naya lead)
PUSH_QUEUE = os.path.join(BASE, "owner-push.jsonl")
PUSH_OFFSET_FILE = os.path.join(BASE, "owner-push.offset")

API_BASE = "http://127.0.0.1:3000/api/owner"
TS_SKEW = 300          # ±5 min
NONCE_TTL = 900        # 15 min

conns = {}
conns_lock = threading.Lock()
seen_events = set()
seen_lock = threading.Lock()
# nonce_hex -> expiry, req_id -> expiry (persisted)
seen_nonces = {}
done_ids = {}


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def get_secret():
    if os.path.isfile(SECRET_FILE):
        with open(SECRET_FILE) as f:
            raw = f.read().strip()
        try:
            s = base64.b64decode(raw)
            if len(s) == 32:
                return s
        except Exception:
            pass
        # simple password / passphrase — SHA-256 se 32-byte key banao
        if raw:
            return hashlib.sha256(raw.encode("utf-8")).digest()
    s = os.urandom(32)
    with open(SECRET_FILE, "w") as f:
        f.write(base64.b64encode(s).decode())
    os.chmod(SECRET_FILE, 0o600)
    log("PANEL SECRET (Boss ko ek baar dein, phir ye line hata dein): "
        + base64.b64encode(s).decode())
    return s


SECRET = get_secret()


def get_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def load_seen():
    try:
        with open(SEEN_FILE) as f:
            d = json.load(f)
        now = time.time()
        for k, exp in (d.get("nonces") or {}).items():
            if exp > now:
                seen_nonces[k] = exp
        for k, exp in (d.get("ids") or {}).items():
            if exp > now:
                done_ids[k] = exp
    except Exception:
        pass


def persist_seen():
    try:
        with open(SEEN_FILE, "w") as f:
            json.dump({"nonces": seen_nonces, "ids": done_ids}, f)
        os.chmod(SEEN_FILE, 0o600)
    except OSError:
        pass


def _keystream(key, n):
    out = b""
    ctr = 0
    while len(out) < n:
        out += hashlib.sha256(key + ctr.to_bytes(4, "big")).digest()
        ctr += 1
    return out[:n]


def encrypt(payload):
    plain = json.dumps(payload, separators=(",", ":")).encode()
    nonce = os.urandom(16)
    key = hashlib.sha256(SECRET + nonce).digest()
    ct = bytes(a ^ b for a, b in zip(plain, _keystream(key, len(plain))))
    mac = hashlib.sha256(key + ct).digest()
    return base64.b64encode(nonce + mac + ct).decode()


def decrypt(envelope):
    try:
        raw = base64.b64decode(envelope.strip())
        if len(raw) < 48:
            return None, None
        nonce, mac, ct = raw[:16], raw[16:48], raw[48:]
        key = hashlib.sha256(SECRET + nonce).digest()
        if not hmac.compare_digest(mac, hashlib.sha256(key + ct).digest()):
            return None, None
        plain = bytes(a ^ b for a, b in zip(ct, _keystream(key, len(ct))))
        return json.loads(plain.decode()), nonce.hex()
    except Exception:
        return None, None


def get_nostr_key():
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE) as f:
            return f.read().strip()
    sk = PrivateKey().to_hex()
    with open(KEY_FILE, "w") as f:
        f.write(sk)
    os.chmod(KEY_FILE, 0o600)
    return sk


SK = get_nostr_key()
PK_XONLY = PrivateKey.from_hex(SK).public_key.format(compressed=True)[1:].hex()


def sign_event(content, tags):
    created = int(time.time())
    core = [0, PK_XONLY, created, 1, tags, content]
    eid = hashlib.sha256(
        json.dumps(core, separators=(",", ":")).encode()).hexdigest()
    sig = PrivateKey.from_hex(SK).sign_schnorr(bytes.fromhex(eid)).hex()
    return {"id": eid, "pubkey": PK_XONLY, "created_at": created, "kind": 1,
            "tags": tags, "content": content, "sig": sig}


def publish_tagged(envelope, tag):
    evt = sign_event(envelope, [["t", tag]])
    msg = json.dumps(["EVENT", evt])
    with conns_lock:
        targets = list(conns.items())
    for url, ws in targets:
        try:
            ws.send(msg)
        except Exception:
            pass


def publish_envelope(envelope):
    publish_tagged(envelope, RES_TAG)


def call_api(action, params):
    token = get_token()
    if not token:
        return {"ok": False, "error": "internal token nahi mila"}
    try:
        if action in ("stats", "inbox"):
            url = API_BASE + "/" + action
            req = urllib.request.Request(url, headers={"x-internal-token": token})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        if action == "thread":
            jid = str((params or {}).get("jid", ""))
            url = API_BASE + "/thread?" + urllib.parse.urlencode({"jid": jid})
            req = urllib.request.Request(url, headers={"x-internal-token": token})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        if action in ("reply",):
            url = API_BASE + "/" + action
            body = json.dumps({
                "jid": str((params or {}).get("jid", "")),
                "text": str((params or {}).get("text", ""))[:1000],
            }).encode()
            req = urllib.request.Request(url, data=body, method="POST",
                                         headers={"x-internal-token": token,
                                                  "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode())
        if action == "accounts":
            url = API_BASE + "/accounts"
            req = urllib.request.Request(url, headers={"x-internal-token": token})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        if action == "disconnect":
            url = API_BASE + "/disconnect"
            body = json.dumps({"number": str((params or {}).get("number", ""))}).encode()
            req = urllib.request.Request(url, data=body, method="POST",
                                         headers={"x-internal-token": token,
                                                  "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        return {"ok": False, "error": "unknown action"}
    except urllib.error.HTTPError as e:
        # HTTP error ki body mein asal wajah hoti hai (JSON {"error": ...}) —
        # sirf "502 Bad Gateway" dikhane ke bajaye wahi asal wajah aage bhejo.
        body_err = ""
        try:
            raw = e.read().decode("utf-8", "replace")
            jb = json.loads(raw)
            if isinstance(jb, dict) and jb.get("error"):
                body_err = str(jb["error"])
        except Exception:
            pass
        msg = body_err or ("HTTP Error %s: %s" % (e.code, e.reason))
        return {"ok": False, "error": "bot API: " + msg[:180]}
    except Exception as e:
        return {"ok": False, "error": "bot API: " + str(e)[:120]}


def handle_envelope(envelope):
    payload, nonce_hex = decrypt(envelope)
    if not payload or not nonce_hex:
        return
    req_id = str(payload.get("id", ""))
    ts = payload.get("ts", 0)
    action = str(payload.get("action", ""))
    params = payload.get("params") or {}
    if not re.fullmatch(r"[0-9a-f]{8,64}", req_id):
        return
    if action not in ("stats", "inbox", "thread", "reply", "accounts", "disconnect"):
        return
    now = time.time()
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return
    if abs(now - ts) > TS_SKEW:
        return
    is_dup = False
    with seen_lock:
        if nonce_hex in seen_nonces:
            return
        seen_nonces[nonce_hex] = now + NONCE_TTL
        if req_id in done_ids and action in ("reply", "disconnect"):
            is_dup = True
    if is_dup:
        # duplicate action rokna — dobara execute nahi hoga
        try:
            publish_envelope(encrypt({"ok": True, "id": req_id, "duplicate": True}))
        except Exception:
            pass
        return
    if action in ("reply", "disconnect"):
        with seen_lock:
            done_ids[req_id] = now + NONCE_TTL
        persist_seen()
    result = call_api(action, params)
    if not isinstance(result, dict):
        result = {"ok": False, "error": "bad api result"}
    result["id"] = req_id
    try:
        publish_envelope(encrypt(result))
    except Exception as e:
        log("publish fail: " + str(e)[:80])
    # kabhi kabhi safai
    if len(seen_nonces) > 3000:
        with seen_lock:
            t = time.time()
            for k in [k for k, exp in seen_nonces.items() if exp < t]:
                del seen_nonces[k]
            for k in [k for k, exp in done_ids.items() if exp < t]:
                del done_ids[k]


def has_req_tag(tags):
    return any(isinstance(t, list) and len(t) > 1 and t[0] == "t" and t[1] == REQ_TAG
               for t in (tags or []))


def listener(url):
    sub_id = "nxp" + os.urandom(4).hex()
    while True:
        try:
            ws = websocket.create_connection(url, timeout=20)
            ws.settimeout(90)
            with conns_lock:
                conns[url] = ws
            since = int(time.time()) - 120
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
                with seen_lock:
                    if eid in seen_events:
                        continue
                    seen_events.add(eid)
                    if len(seen_events) > 2000:
                        seen_events.clear()
                if not has_req_tag(evt.get("tags")):
                    continue
                content = evt.get("content", "")
                if not isinstance(content, str) or len(content) < 32:
                    continue
                threading.Thread(target=handle_envelope,
                                 args=(content,), daemon=True).start()
        except Exception as e:
            log("relay %s down (%s), retry in 5s" % (url, str(e)[:60]))
        with conns_lock:
            conns.pop(url, None)
        time.sleep(5)


def _push_offset_load():
    try:
        with open(PUSH_OFFSET_FILE) as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _push_offset_save(off):
    try:
        with open(PUSH_OFFSET_FILE, "w") as f:
            f.write(str(off))
    except OSError:
        pass


def push_watcher():
    """owner-push.jsonl tail karo; har nayi line ko encrypted Nostr push
    event (PUSH_TAG) ke tor par publish karo taake khula hua Owner Panel
    foran notification dikhaye."""
    # Purani queued lines dobara mat bhejo — aakhir se shuru karo
    try:
        off = os.path.getsize(PUSH_QUEUE) if os.path.isfile(PUSH_QUEUE) else 0
    except OSError:
        off = 0
    _push_offset_save(off)
    log("push watcher on, queue=%s" % PUSH_QUEUE)
    while True:
        try:
            if not os.path.isfile(PUSH_QUEUE):
                time.sleep(2)
                continue
            try:
                size = os.path.getsize(PUSH_QUEUE)
            except OSError:
                time.sleep(2)
                continue
            if size < off:
                off = 0  # file compact hui — shuru se parho
            if size > off:
                with open(PUSH_QUEUE) as f:
                    f.seek(off)
                    chunk = f.read()
                    off = f.tell()
                for line in chunk.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    try:
                        payload = {
                            "id": os.urandom(8).hex(),
                            "ts": int(time.time()),
                            "type": str(item.get("type", "new_lead")),
                            "mid": str(item.get("mid", "")),
                            "name": str(item.get("name", "Unknown"))[:60],
                            "phone": str(item.get("phone", ""))[:20],
                            "worker": str(item.get("worker", ""))[:20],
                            "text": str(item.get("text", ""))[:140],
                            "jid": str(item.get("jid", ""))[:80],
                        }
                        publish_tagged(encrypt(payload), PUSH_TAG)
                        log("push sent: %s (%s)" % (payload["type"], payload["name"][:24]))
                    except Exception as e:
                        log("push fail: " + str(e)[:80])
                _push_offset_save(off)
        except Exception as e:
            log("push watcher err: " + str(e)[:80])
        time.sleep(2)


def _singleton_or_exit():
    import fcntl
    lock_path = os.path.join(BASE, "owner-relay.lock")
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
    load_seen()
    log("owner-relay worker starting. PUBKEY=%s" % PK_XONLY)
    for url in RELAYS:
        threading.Thread(target=listener, args=(url,), daemon=True).start()
    threading.Thread(target=push_watcher, daemon=True).start()  # 📣 panel push notifications
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
