#!/usr/bin/env python3
"""XTTS v2 feminine voice synthesis for NEXORA-MD."""
import sys
import torch
import torchaudio
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts

MODEL_DIR = "/home/hatch/workspace/voice-models/xtts-v2"
REF_WAV = "/home/hatch/workspace/voice-models/ref-voices/lj-female.wav"

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "अस्सलाम ओ अलैकुम बॉस! मैं नेक्सा हूँ।"
    out = sys.argv[2] if len(sys.argv) > 2 else "/home/hatch/workspace/your_files/voice-samples/xtts-sample.wav"
    lang = sys.argv[3] if len(sys.argv) > 3 else "hi"

    print("Loading XTTS config...", flush=True)
    config = XttsConfig()
    config.load_json(f"{MODEL_DIR}/config.json")

    print("Init model...", flush=True)
    model = Xtts.init_from_config(config)
    print("Loading checkpoint (CPU)...", flush=True)
    model.load_checkpoint(config, checkpoint_dir=MODEL_DIR, use_deepspeed=False)
    model.eval()

    print("Synthesizing...", flush=True)
    with torch.no_grad():
        outputs = model.synthesize(
            text,
            config,
            speaker_wav=REF_WAV,
            gpt_cond_len=3,
            language=lang,
        )
    wav = torch.tensor(outputs["wav"]).unsqueeze(0)
    torchaudio.save(out, wav, 24000)
    print(f"Saved: {out} ({len(outputs['wav'])/24000:.1f}s)")

if __name__ == "__main__":
    main()
