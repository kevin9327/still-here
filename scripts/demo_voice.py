"""Narration for the demo video — one clip per story beat, synthesized with edge-tts.

Output: build/voice/<beat>.mp3 + build/voice/lines.json (beat → text, seconds)
"""
import asyncio
import json
import os
import sys

import edge_tts
import imageio_ffmpeg
import subprocess

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "voice")
os.makedirs(OUT, exist_ok=True)
VOICE = "en-US-AndrewNeural"

LINES = {
    "intro": "Still Here is a Ring app for someone who lives alone. The house checks in, so family doesn't have to.",
    "ordinary": "It starts by learning what an ordinary day looks like, from fourteen days of Ring event history: when she is usually up, when she settles, how long the house normally stays quiet.",
    "late_start": "This is the morning the app exists for. It is eleven o'clock, and nothing has happened yet. Instead of paging the family, the home knocks first: a chime on the kitchen Ring Chime, and then it waits ten minutes for any sign of life.",
    "escalate": "Two knocks with no answer, and only then is family contacted, with the last sign of life, what the home already tried, and a single still. Every sentence is checked against the evidence before it is sent; a model may rephrase it, but it cannot invent a time.",
    "answered": "Same morning, but at eleven oh four she walks past the living-room camera. That is the whole answer. No phone, no app, no button. The incident closes, and nobody is disturbed.",
    "went_out": "Leaving through the front door is not a concern either. The home grants a grace period and stays quiet.",
    "outro": "Built on the Ring Partner API: event history, capabilities, chime playback, snapshots, and signed webhooks. Still Here knocks before it alarms.",
}


async def main():
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    meta = {}
    for beat, text in LINES.items():
        path = os.path.join(OUT, f"{beat}.mp3")
        await edge_tts.Communicate(text, VOICE, rate="-4%").save(path)
        probe = subprocess.run([exe, "-i", path], capture_output=True, text=True).stderr
        dur = 0.0
        for line in probe.splitlines():
            if "Duration:" in line:
                h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
                dur = int(h) * 3600 + int(m) * 60 + float(s)
        meta[beat] = {"text": text, "seconds": round(dur, 2)}
        print(f"{beat:10s} {dur:5.1f}s")
    json.dump(meta, open(os.path.join(OUT, "lines.json"), "w"), indent=1)
    print("total", round(sum(v["seconds"] for v in meta.values()), 1), "s")


asyncio.run(main())
