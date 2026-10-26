# Called It Build Plan

## Goal

Build a local Twitch tool where viewers make predictions in chat, a judge spots possible evidence, and a short chat jury decides whether the call gets confirmed. Confirmed calls play on the OBS overlay and earn leaderboard points. The app must also run as a no-credentials scripted demo.

## Project constraints

- Node.js 20+, TypeScript ESM, Express, WebSocket, SQLite, Zod, dotenv, and Vitest.
- Run locally without paid hosting or a public callback URL.
- Use Twitch EventSub over WebSocket; do not require Affiliate features, Channel Points, Predictions, or Bits.
- Keep secrets in `.env`, ignore `data/`, and commit only `.env.example`.
- Provide a free keyword judge fallback that needs no API key.
- Verify Twitch API endpoints, permissions, and EventSub payloads against current official documentation before use.

## Setup

1. Create the repository and add `AGENTS.md` at its root.
2. Register a Twitch app with redirect URL `http://localhost:3000/auth/callback`.
3. Add the client ID, client secret, broadcaster login, and bot login to a local `.env` file.
4. Install Node.js 20 or newer. Install OBS Studio and Chrome for live use.
5. Optionally provide an OpenAI API key. The keyword judge remains the default.
6. Set up a few test viewers or use the scripted demo.

## Build phases

| Phase | Deliverable |
|---|---|
| 1 | TypeScript project scaffold, health route, scripts, and ignored local data |
| 2 | Twitch OAuth, EventSub WebSocket, chat send/receive |
| 3 | SQLite calls, chat commands, limits, expiry, and points |
| 4 | OBS overlay and local WebSocket events |
| 5 | Streamer console, speech transcript, and event context |
| 6 | Keyword judge, optional OpenAI judge, evidence checks, and boldness |
| 7 | Queued chat jury, votes, moderator overrides, and resolution |
| 8 | Live clips, leaderboard overlay, and stream-end recap |
| 9 | Scripted demo, judge-friendly README, and CI |
| 10 | Hardening, review fixes, and final validation |

## Implementation prompts

### 1. Scaffold

> Read `AGENTS.md`. Set up TypeScript ESM with Express, ws, better-sqlite3, Zod, dotenv, and Vitest. Add the `src/`, `web/`, `demo/`, and ignored `data/` folders, npm scripts for `dev`, `demo`, `test`, and `lint`, and a `/health` route. Extend the existing README and `.env.example` without replacing them.

### 2. Twitch auth and chat

> Implement `twitch/auth.ts` with the OAuth authorization code flow, local callback, token storage in `data/tokens.json`, and refresh. Implement `twitch/eventsub.ts` for WebSocket connect, welcome, keepalive, reconnect, and chat subscription. Implement `twitch/helix.ts` chat sending. Check scopes and payloads against current official Twitch docs and explain the chosen scopes.

### 3. Calls and commands

> Implement `core/callStore.ts` and `chat/commands.ts` per `AGENTS.md`: `!call`, `!mycalls`, `!prophets`, `!receipts`, `!cap`, and moderator/broadcaster commands. Enforce prediction length, blocked words, one open call per viewer, a 30-call cap, and 30-minute expiry. Add tests for validation, limits, and permissions.

### 4. Overlay and WebSocket bus

> Build the local WebSocket bus and `web/overlay` as a transparent 1920×1080 OBS Browser Source. Include the open-call ticker, a 10-second jury countdown and tally, a CALLED IT card, and Hall of Cap. Use bold stream-readable typography, synthetic Web Audio sounds, and respect `prefers-reduced-motion`. Add `/overlay?test=1` to preview every state.

### 5. Streamer console and speech

> Build `web/console` for Chrome. Capture final speech results with the Web Speech API, restart recognition when it stops, and add timestamped transcript lines to the rolling context window. Show open calls, judge evidence, Confirm/Reject/Nuke controls, and a judge toggle. Include Twitch events only when supported by the granted permissions; clearly skip unavailable event types.

### 6. Judge

> Implement the judge provider contract in `AGENTS.md`. Every 15 seconds, evaluate open calls against new context. The free keyword judge should match relevant entities and words, honor simple time phrases, and account for negation. The optional OpenAI judge should use strict JSON output, Zod validation, a timeout, and keyword fallback. Score call boldness from 1–5 and reject all evidence from before a call. Add fixed-fixture tests for true, false, partial, and pre-call evidence.

### 7. Jury, resolution, and scoring

> Implement `core/jury.ts` and scoring per `AGENTS.md`: one jury at a time, one vote per viewer, call authors cannot vote, defined thresholds and no-vote fallback, and moderator overrides. Resolve correct calls to points and an overlay celebration; resolve CAP calls to Hall of Cap. Add tests for jury rules and scoring.

### 8. Clips and session cards

> On a confirmed call, use Helix Create Clip only when the broadcaster is live and has granted the required scope; fail quietly. Add a `!prophets` overlay card for eight seconds and a stream-end recap with the boldest correct call, biggest CAP, and top prophet.

### 9. Demo, README, and CI

> Build `npm run demo` as a scripted four-minute replay through the real pipeline: fake viewers, transcript, reaction burst, judge evidence, jury votes, one CALLED IT, and one CAP. It must run without Twitch credentials. Finish the README with platform-specific quick starts, screenshot placeholders, architecture, live setup, and how Codex was used. Add CI for install, lint, and tests on each push.

### 10. Hardening

> Review the whole app as if a first-time judge were testing it. Check EventSub reconnects, token refresh races, chat rate limits, unfiltered viewer text reaching the overlay, behavior without an OpenAI key, and failures in optional clip creation. Fix issues and list any known limits.

## Validation checklist

- `npm ci`, `npm run lint`, and `npm test` succeed on a clean clone.
- `npm run demo` works without Twitch credentials and drives the real pipeline.
- The overlay and console load locally and receive live WebSocket updates.
- Chat commands explain invalid input and permission failures.
- The judge only uses evidence created after each call.
- A queued jury starts after the preceding overlay moment finishes.
- Twitch OAuth tokens and local databases remain ignored by Git.
