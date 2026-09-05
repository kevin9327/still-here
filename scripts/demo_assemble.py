"""Assemble build/frames + build/voice into build/still_here_demo.mp4 (1920x1080, 24 fps, H.264).

Each beat is stretched so its narration fits: the beat's captured frames are shown at their
natural pace, then the last frame holds until the voice line ends. Intro and outro are cards.
"""
import json
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FR = os.path.join(ROOT, "build", "frames")
VOICE = os.path.join(ROOT, "build", "voice")
COMP = os.path.join(ROOT, "build", "comp")
OUT = os.path.join(ROOT, "build", "still_here_demo.mp4")
W, H = 1920, 1080
OUT_FPS = 24
BG, INK, SOFT, AMBER = (0x12, 0x12, 0x11), (0xF3, 0xEE, 0xE4), (0xA8, 0x9F, 0x90), (0xE3, 0xA7, 0x4F)

beats = json.load(open(os.path.join(ROOT, "build", "beats.json")))
lines = json.load(open(os.path.join(VOICE, "lines.json")))
SRC_FPS = beats["fps"]

CAPTIONS = {
    "ordinary": "14 days of Ring event history → a learned rhythm",
    "late_start": "11:00, nothing yet → the home knocks first (Ring Chime)",
    "escalate": "Two unanswered knocks → family, with evidence — fact-gated",
    "answered": "A step past a camera is the answer. Nobody is disturbed.",
    "went_out": "Out the front door → grace period, no knock",
}


def font(size, bold=False):
    for name in (["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        p = os.path.join("C:/Windows/Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def card(title, sub, lines_=()):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((W // 2, 400), title, font=font(110, True), fill=INK, anchor="mm")
    d.line([(W // 2 - 70, 480), (W // 2 + 70, 480)], fill=AMBER, width=5)
    d.text((W // 2, 545), sub, font=font(44), fill=SOFT, anchor="mm")
    y = 660
    for ln in lines_:
        d.text((W // 2, y), ln, font=font(32), fill=SOFT, anchor="mm")
        y += 52
    return img


def caption(img, text):
    d = ImageDraw.Draw(img, "RGBA")
    f = font(34, True)
    tw = d.textlength(text, font=f)
    x0, y0 = 48, H - 96
    d.rounded_rectangle([x0, y0, x0 + tw + 56, y0 + 62], radius=14, fill=(0, 0, 0, 190))
    d.rectangle([x0, y0 + 10, x0 + 6, y0 + 52], fill=AMBER)
    d.text((x0 + 28, y0 + 31), text, font=f, fill=INK, anchor="lm")
    return img


shutil.rmtree(COMP, ignore_errors=True)
os.makedirs(COMP, exist_ok=True)
n = 0
timeline = []  # (beat, start_sec, end_sec) for the audio mix


def emit(img, count):
    global n
    for _ in range(count):
        img.save(os.path.join(COMP, f"c{n:05d}.png"))
        n += 1


def sec(frames_):
    return frames_ / OUT_FPS


# intro
start = n
emit(card("Still Here", "the house checks in, so family doesn't have to",
          ("A Ring app for someone who lives alone", "Build, Ship, Shape · Ring track · caretaking")),
     int(OUT_FPS * max(4.0, lines["intro"]["seconds"] + 0.6)))
timeline.append(("intro", sec(start), sec(n)))

names = [b["name"] for b in beats["beats"]]
starts = [b["start"] for b in beats["beats"]]
for i, name in enumerate(names):
    if name == "end":
        break
    lo, hi = starts[i], starts[i + 1]
    start = n
    last = None
    for k in range(lo, hi):
        img = Image.open(os.path.join(FR, f"f{k:05d}.png")).convert("RGB")
        if img.size != (W, H):
            img = img.resize((W, H), Image.LANCZOS)
        caption(img, CAPTIONS[name])
        emit(img, 2)  # 12 → 24 fps
        last = img
    need = int(OUT_FPS * (lines[name]["seconds"] + 0.8))
    if n - start < need:
        emit(last, need - (n - start))
    timeline.append((name, sec(start), sec(n)))

start = n
emit(card("Still Here", "knocks before it alarms",
          ("github.com/kevin9327/still-here · MIT", "Ring Partner API · event history · capabilities · chime playback · snapshots · signed webhooks")),
     int(OUT_FPS * max(5.0, lines["outro"]["seconds"] + 1.0)))
timeline.append(("outro", sec(start), sec(n)))

exe = imageio_ffmpeg.get_ffmpeg_exe()
video = os.path.join(ROOT, "build", "_video.mp4")
subprocess.run([exe, "-y", "-framerate", str(OUT_FPS), "-i", os.path.join(COMP, "c%05d.png"),
                "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", video],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# audio: each clip delayed to its beat start, mixed over silence of the full length
inputs, filters, tags = ["-i", video], [], []
for j, (name, s, e) in enumerate(timeline):
    inputs += ["-i", os.path.join(VOICE, f"{name}.mp3")]
    filters.append(f"[{j + 1}:a]adelay={int(s * 1000)}|{int(s * 1000)}[a{j}]")
    tags.append(f"[a{j}]")
filters.append(f"{''.join(tags)}amix=inputs={len(tags)}:normalize=0:dropout_transition=0[aout]")
subprocess.run([exe, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", OUT],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.remove(video)
print("timeline:", [(b, round(s, 1), round(e, 1)) for b, s, e in timeline])
print(OUT, round(n / OUT_FPS, 1), "s", os.path.getsize(OUT) // 1024, "KB")
