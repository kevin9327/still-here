# Friction log — building Still Here on the Ring Partner API

Kept while building the Ring-track entry for Build, Ship, Shape (September 2026). Each item is
something that cost real time or changed the design, with what we did about it.

## 1. Playground tokens live ~30 minutes
The Developer Playground token is the fastest way to get going (one click, no OAuth), but it
expires in about half an hour. Every dev-server restart or coffee break means regenerating and
pasting again. We built `POST /api/live` to re-read the token on demand and `scripts/ring-probe.ts`
to fail fast with a clear "regenerate at …" message instead of a bare 401.
**Ask:** a longer-lived sandbox token, or a CLI login that refreshes it.

## 2. Chime playback is an `audio_ref`, not text
`POST /v1/devices/{id}/media/audio/playback` plays a stored audio clip on the Chime. A caretaking
app wants to *say* "are you there?"; we settled for a distinct check-in chime and put the words in
the family message instead. Worth documenting up front that arbitrary TTS is not on the table.

## 3. No "send me a test event" in the Playground
Webhook v1.1 is well documented (envelope, `X-Signature` HMAC-SHA256 over the raw bytes), but
there was no way to have Ring post a sample motion/button event to our endpoint. We wrote a
replay route (`/api/sim`) that signs synthetic events exactly as Ring would and posts them to our
own webhook, so the demo exercises the real verify → parse → engine path. A test-event button in
the Playground would have saved that afternoon.

## 4. Event history is per device
`GET /v1/history/devices/{id}/events` means learning a household rhythm is N calls for N cameras,
plus a client-side merge and sort. A per-account history endpoint (or a `device_ids[]` filter)
would make "what happened in this home today" one request.

## 5. Developer registration: "Complete Registration" is a heading
On the Amazon Developer registration page the section title reads "Complete Registration" while
the actual submit is the "Agree and Continue" button at the very bottom of a long form. Two of us
clicked the heading first. Not a Ring issue, but it is the first screen every Ring developer sees.

## What worked well
The JSON:API shape is consistent across devices/status/capabilities/history; the sample repo shows
the WHEP flow end to end; sandbox devices meant we could build a real integration with no hardware.
