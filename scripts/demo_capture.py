"""Capture the demo video frames from the real dashboard (needs `npm run dev` on :3000).

The script clicks the same sandbox buttons a caregiver would, at 12 fps, and records where each
story beat starts so demo_assemble.py can lay captions and narration over the right seconds.
Every event still travels through POST /api/webhook/ring — nothing is faked for the camera.

Output: build/frames/f%05d.png + build/beats.json
"""
import json
import os
import shutil
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:3000"
OUT = os.path.join(ROOT, "build", "frames")
FPS = 12

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)


def post(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=30))


def household():
    return json.load(urllib.request.urlopen(BASE + "/api/household", timeout=30))


frame = 0
beats = []


def shot(page, n=1):
    global frame
    for _ in range(n):
        page.screenshot(path=os.path.join(OUT, f"f{frame:05d}.png"))
        frame += 1


def beat(name):
    beats.append({"name": name, "start": frame})
    print(f"beat {name} @ frame {frame} ({frame / FPS:.1f}s)")


def click(page, label, settle=1.0, frames=6):
    """Click a sandbox button by its visible text and let the dashboard re-poll."""
    page.get_by_role("button", name=label, exact=True).click()
    page.wait_for_timeout(int(settle * 1000))
    shot(page, frames)


def wait_phase(phase, tries=20):
    for _ in range(tries):
        if household()["watch"]["phase"] == phase:
            return True
        time.sleep(0.3)
    return False


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page = ctx.new_page()

    # A known starting point: an ordinary day, 09:00, so the first frame is calm.
    post("/api/sim", {"scenario": "normal", "toMinute": 9 * 60, "replay": True})
    page.goto(BASE + "/")
    page.wait_for_timeout(1500)
    # The dashboard is laid out for ~1400px; at 1920x1080 it leaves the lower third empty.
    # Scale the document so the frame is filled without touching the app's CSS.
    page.add_style_tag(content="html { zoom: 1.32; }")
    page.wait_for_timeout(600)

    # 1) An ordinary day: the rhythm and the timeline filling in
    beat("ordinary")
    shot(page, 24)
    click(page, "12:00", frames=14)
    click(page, "19:00", frames=14)
    click(page, "22:00", frames=20)

    # 2) The morning that never starts: calm at 09:00, knock at 11:00
    # The scenario button jumps to 09:00, which is already past the morning grace (06:44 + 90 min)
    # and would knock immediately. Start the day at 07:00 through the same API instead, so the
    # first move past the grace window is the 11:00 click — the knock happens on camera.
    beat("late_start")
    post("/api/sim", {"scenario": "late_start", "toMinute": 7 * 60, "replay": True})
    page.wait_for_timeout(1400)
    shot(page, 26)
    click(page, "11:00", settle=1.4, frames=8)
    assert wait_phase("knocking"), "expected knocking after 11:00"
    page.wait_for_timeout(600)
    shot(page, 30)

    # 3) Two unanswered knocks → family, with evidence
    beat("escalate")
    click(page, "+10 min", settle=1.4, frames=26)          # knock 2
    click(page, "+10 min", settle=1.6, frames=8)           # escalation
    assert wait_phase("escalated"), "expected escalation after two silent knocks"
    page.wait_for_timeout(1800)                            # the family message is phrased server-side
    shot(page, 48)
    page.mouse.wheel(0, 500)
    page.wait_for_timeout(500)
    shot(page, 22)
    page.mouse.wheel(0, -500)
    page.wait_for_timeout(300)

    # 4) The same morning, but she walks past the living-room camera after the knock
    beat("answered")
    post("/api/sim", {"scenario": "late_start", "toMinute": 7 * 60, "replay": True})
    page.wait_for_timeout(1400)
    shot(page, 10)
    click(page, "11:00", settle=1.4, frames=8)
    assert wait_phase("knocking")
    shot(page, 14)
    h = household()
    at = h["startOfDay"] + (11 * 60 + 4) * 60_000
    post("/api/webhook/ring", {
        "meta": {"version": "1.1", "time": "2026-09-05T02:04:00.000Z", "request_id": "demo-answer", "account_id": "ava1.ring.account.SIMULATED"},
        "data": {
            "id": "demo-answer-1", "type": "motion_detected",
            "attributes": {"source": "ava1.ring.device.SIMLIVING1", "source_type": "devices", "timestamp": at, "sub_type": "human"},
            "relationships": {"devices": {"links": {"self": "/v1/devices/ava1.ring.device.SIMLIVING1"}}},
        },
    })
    page.wait_for_timeout(1200)
    shot(page, 14)
    click(page, "+10 min", settle=1.6, frames=8)
    assert wait_phase("calm"), "a step past the camera should close the incident"
    page.wait_for_timeout(500)
    shot(page, 40)

    # 5) Went out through the front door: grace period, no knock
    beat("went_out")
    click(page, "Went out", settle=1.4, frames=12)
    click(page, "12:00", settle=1.4, frames=30)

    beat("end")
    ctx.close()
    browser.close()

json.dump({"fps": FPS, "frames": frame, "beats": beats}, open(os.path.join(ROOT, "build", "beats.json"), "w"), indent=1)
print("frames", frame, "≈", round(frame / FPS, 1), "s")
