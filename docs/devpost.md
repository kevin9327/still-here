# Devpost submission draft — Still Here (Ring track)

Second entry to **Build, Ship, Shape: Amazon Developer Hackathon** (first entry: Opportunity Radar, Alexa+ track).
Rules allow multiple submissions as long as they are substantially different — this one is a Ring
caretaking app; the other is an Alexa+ MCP server for public grants.

## Project name
Still Here

## Elevator pitch (≤ 200 chars)
A Ring app for someone who lives alone: it learns her ordinary day, and when the day stops looking ordinary it knocks (a chime) before it ever alarms the family.

## Track
Ring — priority categories: caretaking, accessibility

## Mini challenge
Open Source (new public MIT repo created during the submission window). AWS Builder: not claimed —
the Bedrock rephrase path exists in `lib/notify/summary.ts` but was not exercised against a live
account, and we don't claim what we didn't run.

## Story

### Inspiration
Every "is mum okay?" product solves the easy half: detect an anomaly, push a notification. In a
real household that fails twice a week — she slept in, she was in the garden, the cat tripped the
hallway camera. After the third false alarm the family mutes the app, and now it is worse than
nothing. We wanted the *house* to take the first step, the way a good neighbour knocks before
calling anyone.

### What it does
- **Learns a rhythm** from 14 days of Ring event history (`GET /v1/history/devices/{id}/events`):
  first and last presence per day (median ± MAD so one 3 am bathroom trip doesn't redefine
  "morning"), hourly presence probability (which also yields quiet hours), and the p90 waking gap.
- **Watches today** through Ring webhooks (v1.1 envelopes, HMAC-SHA256 `X-Signature` verified
  against the raw bytes before parsing).
- **Knocks first**: when the morning never starts, or the house goes quiet for longer than this
  household ever does, it plays a check-in chime on the Ring Chime
  (`POST /v1/devices/{id}/media/audio/playback`) and waits ten minutes.
- **Any sign of life is an answer** — motion, a doorbell press, a door event. A step past a camera
  closes the incident silently. No phone, no app, no button, which is the point for someone who
  doesn't carry a phone around the house.
- **Escalates only after two unanswered knocks**, to family, with the last sign of life, what the
  home already tried, and a single still (`POST /v1/devices/{id}/media/image/download`).
- Leaving through the front door earns an away grace period; vehicle motion is never a sign of life;
  it never knocks during learned quiet hours; it stands down even after escalating if she walks past
  a camera.

### How we built it
- Next.js 14 (App Router) + TypeScript. `lib/rhythm` is pure — `step(state, events, model, now)`
  returns `knock / escalate / resolve` actions and nothing else — so the escalation policy is
  covered by 22 unit tests rather than hope.
- `lib/ring`: a thin Partner API client (server-side only, as Ring requires), webhook types, and
  constant-time signature verification.
- `lib/sim`: a synthetic household (14 days of history, four scenarios). The sandbox replays every
  synthetic event through the *real* signed `/api/webhook/ring` route, so the demo exercises the
  same parse → verify → engine path as production traffic.
- `POST /api/live` switches the same dashboard to a real account from a Ring Developer Playground
  token; `scripts/ring-probe.ts` inspects an account from the terminal.
- The family message is assembled deterministically first, then a model is asked only to
  *rephrase* it: Ollama on the home hub → Bedrock → the rules sentence. A fact gate rejects any
  draft that drops the pre-written "last sign of life" sentence or introduces a clock time that is
  not in the evidence.

### Challenges
- The local model turned "14 days learned" into "last sign of life was 14 days ago" — in a message
  to a worried family. That draft is now a regression test, and the gate ships the rules version
  whenever a model fails it.
- Getting the knock timing right without a physical Chime: the Playground/sandbox exposes synthetic
  devices and events, so the demo runs against the same endpoints the production path uses, and the
  engine never sees Ring types directly.

### Accomplishments
A caretaking design that respects the person being cared for: it asks *her* first, it treats
walking to the kitchen as a valid answer, it records nothing continuously, and it only pulls a
family in when the home itself could not get an answer.

### What we learned
Ring's event history is enough to learn a household's rhythm without any wearable — and the chime
is a surprisingly humane output channel.

### What's next
Multi-camera households (component_id), a weekly "how was her week" summary for family, and a
proper OAuth account-linking flow for long-lived installs.

## Built with
TypeScript, Next.js, React, Node.js, Ring Partner API (devices · capabilities · event history ·
chime audio playback · image snapshot · webhooks), Vitest, Ollama, Amazon Bedrock (optional path),
Playwright + edge-tts (demo video)

## Links
- Repo: https://github.com/kevin9327/still-here (MIT)
- Demo video: https://youtu.be/cAnbiR2ndcw (1:22, English)
- Devpost entry: https://devpost.com/software/still-here-x7um2q (submitted 2026-09-05)
- Try it: `npm install && npm run dev` → http://localhost:3000 (sandbox needs no token)

## Product feedback (required)
**Ring Partner API / Developer Playground**
- Used for: device discovery, capabilities (to find which device can be knocked on), 14-day event
  history to learn a rhythm, webhook ingestion, chime playback, snapshot at escalation.
- What worked: the Playground token is genuinely one click; the JSON:API shape is consistent;
  the sample repo shows the WHEP flow end to end; sandbox devices/events mean no hardware is needed
  to build a real integration.
- What needs work: (1) the Playground token lives ~30 minutes, which is fine for exploring but
  means every dev-server restart is a paste; a longer sandbox token or a CLI login would help.
  (2) Chime playback takes an `audio_ref`, not arbitrary TTS — a caretaking app wants to say
  *"are you there?"*, not just ring. (3) Webhook docs explain the v1.1 envelope well, but a
  "send me a test event" button in the Playground would remove the need for our own replay route.
  (4) Event history is per device; a per-account merged history endpoint would save N calls.
- Onboarding: developer registration → Playground → first `GET /v1/devices` took under an hour.
- Would we build with it again: yes — the API surface is small enough to read in one sitting.
