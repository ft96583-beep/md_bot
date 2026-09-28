#!/usr/bin/env python3
# BOXXAXMD voice engine — WhatsApp voice note (ogg/opus) ko text mein badlo.
# Usage: voice.py <audio-file>   →   {"text": "...", "lang": "ur"} (stdout, JSON)
# Model: /home/hatch/workspace/voice-models/base (local, no download needed)
import sys
import json

MODEL_DIR = "/home/hatch/workspace/voice-models/base"

_model = None

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(MODEL_DIR, device="cpu", compute_type="int8")
    return _model

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"text": "", "lang": ""}))
        return
    try:
        model = get_model()
        # vad_filter: khamoshi kat do — chhoti voice notes par tez + sahi
        segs, info = model.transcribe(sys.argv[1], vad_filter=True)
        txt = " ".join(s.text for s in segs).strip()
        print(json.dumps({"text": txt, "lang": info.language or ""}))
    except Exception as e:
        print(json.dumps({"text": "", "lang": "", "error": str(e)[:200]}))

main()
