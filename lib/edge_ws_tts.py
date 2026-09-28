#!/usr/bin/env python3
"""
edge_ws_tts.py — Microsoft Edge neural TTS (natural voices) over a RAW WebSocket.

Why raw? The sandbox egress proxy mangles the WS 101 handshake's Connection
header, so aiohttp / websockets / edge-tts all refuse the upgrade. We do
CONNECT + TLS ourselves (verified working), send the upgrade request, and
speak raw RFC 6455 frames — no library handshake strictness.

Reuses the edge-tts package only for SSML building + DRM token generation.

Usage:
    edge_ws_tts.py --voice ur-PK-UzmaNeural --text "..." --out out.mp3
                    [--rate +0%] [--pitch +0Hz]
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import urllib.parse
import uuid

sys.path.insert(0, "/home/hatch/workspace/voice-env/lib/python3.12/site-packages")
from edge_tts.communicate import (
    mkssml,
    ssml_headers_plus_data,
    date_to_string,
    connect_id,
    remove_incompatible_characters,
)
from edge_tts.constants import WSS_URL, SEC_MS_GEC_VERSION, WSS_HEADERS, TRUSTED_CLIENT_TOKEN
from edge_tts.data_classes import TTSConfig
from edge_tts.drm import DRM
from xml.sax.saxutils import escape

CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOST = "speech.platform.bing.com"


def open_tls_tunnel():
    """CONNECT through the egress proxy, then TLS with the system CA bundle."""
    p = urllib.parse.urlparse(os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY"))
    if not p.hostname:
        raise RuntimeError("no https_proxy set")
    s = socket.create_connection((p.hostname, p.port), timeout=20)
    auth = base64.b64encode(f"{p.username}:{p.password}".encode()).decode()
    s.sendall(
        ("CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n"
         "Proxy-Authorization: Basic %s\r\n\r\n" % (HOST, HOST, auth)).encode()
    )
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("proxy CONNECT failed")
        resp += chunk
    if b" 200 " not in resp.split(b"\r\n")[0]:
        raise RuntimeError("proxy CONNECT rejected: %s" % resp.split(b"\r\n")[0][:80])
    ctx = ssl.create_default_context(cafile=CA_BUNDLE)
    return ctx.wrap_socket(s, server_hostname=HOST)


class RawWS:
    def __init__(self, sock):
        self.sock = sock
        self.f = sock.makefile("rb")

    def _read_exact(self, n):
        data = b""
        while len(data) < n:
            chunk = self.f.read(n - len(data))
            if not chunk:
                raise ConnectionError("socket closed mid-frame")
            data += chunk
        return data

    def handshake(self, path):
        key = base64.b64encode(os.urandom(16)).decode()
        headers = DRM.headers_with_muid(dict(WSS_HEADERS))
        headers.pop("Sec-WebSocket-Version", None)
        lines = ["GET %s HTTP/1.1" % path,
                 "Host: %s" % HOST,
                 "Upgrade: websocket",
                 "Connection: Upgrade",
                 "Sec-WebSocket-Key: %s" % key,
                 "Sec-WebSocket-Version: 13"]
        lines += ["%s: %s" % (k, v) for k, v in headers.items()]
        lines += ["", ""]
        self.sock.sendall("\r\n".join(lines).encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.f.read(4096)
            if not chunk:
                raise RuntimeError("no handshake response")
            resp += chunk
        status = resp.split(b"\r\n")[0]
        if b"101" not in status:
            raise RuntimeError("WS upgrade rejected: %s" % status[:100])
        # best-effort accept-key verification (proxy may mangle headers)
        m = {}
        for line in resp.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                m[k.strip().lower()] = v.strip()
        accept = m.get(b"sec-websocket-accept", b"").decode("latin1")
        if accept:
            expect = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            if accept != expect:
                raise RuntimeError("bad Sec-WebSocket-Accept")

    def send_text(self, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        frame = bytearray([0x81])  # FIN + text
        n = len(payload)
        if n < 126:
            frame.append(0x80 | n)
        elif n < 65536:
            frame.append(0x80 | 126)
            frame += struct.pack("!H", n)
        else:
            frame.append(0x80 | 127)
            frame += struct.pack("!Q", n)
        frame += mask
        frame += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(frame))

    def _send_pong(self, payload):
        self.sock.sendall(bytes(bytearray([0x8A, len(payload)]) + payload))

    def recv_message(self):
        """Returns (is_text, bytes). Answers pings internally."""
        msg = bytearray()
        is_text = True
        while True:
            hdr = self._read_exact(2)
            fin = hdr[0] & 0x80
            opcode = hdr[0] & 0x0F
            ln = hdr[1] & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._read_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._read_exact(8))[0]
            payload = self._read_exact(ln) if ln else b""
            if opcode == 0x8:  # close
                raise StopIteration("server closed")
            if opcode == 0x9:  # ping
                self._send_pong(payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x1:
                is_text = True
            elif opcode == 0x2:
                is_text = False
            msg += payload
            if fin:
                return is_text, bytes(msg)


def synthesize(text, voice, out_path, rate="+0%", pitch="+0Hz",
               output_format="audio-24khz-48kbitrate-mono-mp3"):
    tc = TTSConfig(voice=voice, rate=rate, volume="+0%", pitch=pitch,
                   boundary="SentenceBoundary")
    text = remove_incompatible_characters(text)
    ssml = mkssml(tc, escape(text))
    config_body = json.dumps(
        {"context": {"synthesis": {"audio": {
            "metadataoptions": {
                "sentenceBoundaryEnabled": "false",
                "wordBoundaryEnabled": "false",
            },
            "outputFormat": output_format,
        }}}},
        separators=(",", ":"),
    )
    config_msg = (
        "X-Timestamp:" + date_to_string() + "\r\n"
        "Content-Type:application/json; charset=utf-8\r\n"
        "Path:speech.config\r\n\r\n"
        + config_body + "\r\n"
    )
    ssml_msg = ssml_headers_plus_data(connect_id(), date_to_string(), ssml)
    path = ("/consumer/speech/synthesize/readaloud/edge/v1"
            "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN +
            "&ConnectionId=" + connect_id() +
            "&Sec-MS-GEC=" + DRM.generate_sec_ms_gec() +
            "&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION)

    sock = open_tls_tunnel()
    sock.settimeout(45)
    ws = RawWS(sock)
    try:
        ws.handshake(path)
        ws.send_text(config_msg)
        ws.send_text(ssml_msg)
        audio = bytearray()
        while True:
            try:
                is_text, data = ws.recv_message()
            except StopIteration:
                break
            if is_text:
                head = data.split(b"\r\n\r\n")[0]
                if b"Path:turn.end" in head:
                    break
                continue
            if len(data) < 2:
                continue
            hl = int.from_bytes(data[:2], "big")
            header = data[2:2 + hl]
            payload = data[2 + hl + 2:]
            if b"Path:audio" in header and payload:
                audio.extend(payload)
    finally:
        try:
            sock.close()
        except OSError:
            pass
    if not audio:
        raise RuntimeError("no audio received from TTS service")
    with open(out_path, "wb") as f:
        f.write(audio)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="ur-PK-UzmaNeural")
    ap.add_argument("--text", default="")
    ap.add_argument("--file", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    a = ap.parse_args()
    text = a.text or (open(a.file, encoding="utf-8").read() if a.file else "")
    if not text.strip():
        print("empty text", file=sys.stderr)
        sys.exit(2)
    out = synthesize(text, a.voice, a.out, rate=a.rate, pitch=a.pitch)
    print("OK %s bytes=%d" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    main()
