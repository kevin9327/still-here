"""Capture dashboard stills for the README and the demo video (needs `npm run dev` running)."""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://localhost:3000"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
os.makedirs(OUT, exist_ok=True)


def sim(body):
    req = urllib.request.Request(
        BASE + "/api/sim", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=30))


SHOTS = [
    ("calm", [{"scenario": "normal", "toMinute": 14 * 60, "replay": True}]),
    ("knocking", [{"scenario": "late_start", "toMinute": 7 * 60, "replay": True}, {"toMinute": 11 * 60}]),
    (
        "escalated",
        [
            {"scenario": "late_start", "toMinute": 7 * 60, "replay": True},
            {"toMinute": 11 * 60},
            {"toMinute": 11 * 60 + 10},
            {"toMinute": 11 * 60 + 20},
        ],
    ),
]

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome")
    page = browser.new_context(viewport={"width": 1400, "height": 1000}, device_scale_factor=2).new_page()
    for name, steps in SHOTS:
        for s in steps:
            sim(s)
        page.goto(BASE)
        page.wait_for_timeout(2200)
        path = os.path.join(OUT, f"{name}.png")
        page.screenshot(path=path, full_page=True)
        print("saved", path)
    browser.close()
