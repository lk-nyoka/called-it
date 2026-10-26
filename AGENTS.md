# AGENTS.md — Called It

Context for Codex. Read this before every task in this repo.

## What we're building
**Called It** is a Twitch tool where viewers make free-text predictions in chat (`!call <prediction>`). An AI judge watches the live stream (the streamer's speech transcript plus Twitch events). When a call looks like it came true, the overlay opens a 10-second **chat jury** (`!receipts` / `!cap`). If chat backs it, the overlay plays a "CALLED IT" moment showing the viewer's name, their original words and how long ago they called it. Correct calls score points on a persistent **Prophets** leaderboard.

Built for the Codex x TwitchCon Hackathon (deadline 2 Nov 2026, 23:59 SAST). Judging criteria: originality, usefulness or entertainment for streamers and viewers, build quality and use of Codex, and ease of use plus how fun it is to watch.

## Hard constraints
- **Free to run.** No paid hosting. Everything runs locally on the streamer's laptop. The AI judge must have a provider interface with a working **keyword fallback that needs no API key**.
- **No public URL needed.** Use **EventSub over WebSocket** (not webhooks) for chat and events.
- **Must work for non-Affiliate channels.** Do NOT depend on Channel Points, Predictions or Bits.
- **Never commit secrets.** Keep secrets in `.env`, commit `.env.example`, and gitignore `data/` and `.env`.
- **Judges must be able to run it** without Twitch credentials: `npm run demo` replays a scripted session end to end.
- **Verify every Twitch endpoint, scope and EventSub subscription type against https://dev.twitch.tv/docs before using it.** Do not guess field names.

## Stack
- Node.js 20+, TypeScript, ESM
- `express` for the local server (serves the overlay and console), `ws` for the local WebSocket bus to the pages
- Twitch: EventSub WebSocket (`channel.chat.message`, plus `channel.follow`, `channel.raid`, `channel.subscribe` where available), Helix "Send Chat Message", Helix "Create Clip"
- Storage: SQLite via `better-sqlite3` (file at `data/calledit.db`)
- Overlay and console: plain HTML/CSS/JS (no framework) in `web/`
- Speech: Chrome **Web Speech API** in the streamer console page (free, captures the mic only)
- Tests: `vitest`

## Architecture
```
Twitch EventSub WS ─┐
                    ├─> EventHub ──> CallStore (SQLite)
Console page (speech)┘      │            │
                            ▼            ▼
                       Judge (every ~15s: open calls + recent context window)
                            │  candidates {callId, confidence, evidence}
                            ▼
                       JuryManager (10s chat vote, streamer veto)
                            │
                            ▼
              Resolver -> Scoring -> Overlay WS -> Create Clip -> chat message
```

### Modules (`src/`)
- `config.ts` loads and validates env.
- `twitch/auth.ts` handles the OAuth user token for the bot/broadcaster (local redirect to `http://localhost:3000/auth/callback`) and stores tokens in `data/tokens.json` with refresh.
- `twitch/eventsub.ts` manages the WebSocket session, subscriptions, keepalive and reconnect.
- `twitch/helix.ts` wraps sendChatMessage and createClip.
- `chat/commands.ts` handles `!call`, `!mycalls`, `!prophets`, `!receipts`, `!cap`, `!calledit` (help), plus the mod/streamer commands `!yes <id>`, `!no <id>`, `!nuke <id>` and `!judge on|off`.
- `core/callStore.ts` covers create, list, expire and resolve calls, and the leaderboard.
- `core/context.ts` keeps a rolling window (last ~5 min) of transcript lines and stream events with timestamps.
- `judge/index.ts` defines the `JudgeProvider` interface. Implementations: `openai.ts` (optional, small cheap model, JSON output) and `keyword.ts` (no key needed). A provider is chosen via env `JUDGE_PROVIDER`.
- `core/jury.ts` handles the vote window, tally, thresholds and veto.
- `core/scoring.ts` computes points.
- `server/` contains the express app and WS bus. Pages: `/overlay` (OBS Browser Source, 1920x1080, transparent) and `/console` (streamer control and speech).
- `demo/` contains the scripted replay (fake chat, transcript and events) that drives the real pipeline.

## Rules of the game
- One open call per viewer at a time. Global cap of 30 open calls. Text is 5–120 chars.
- Run call text through a blocklist filter before storing; never show unfiltered text on the overlay. Mods can `!nuke`.
- Calls expire after 30 min (configurable) or at stream end. Expired calls are "busted".
- When a call is created, the judge assigns **boldness 1–5** (keyword mode gives 2).
- Jury: 10s window. Resolve as correct if receipts ≥ 60% and votes ≥ 2 (thresholds configurable). With 0 votes, fall back to the judge confidence (≥ 0.85 counts as correct). The streamer veto overrides everything.
- Points = `10 × boldness × earlyBonus`, where `earlyBonus = min(2, 1 + minutesBeforeResolution/30)`.
- Never let the judge resolve a call using evidence from before the call was made.

## Judge contract
Input: open calls (id, text, createdAt) and context entries (t, source: "speech" | "event" | "chat", text).
Output JSON: `{ "candidates": [ { "callId": number, "confidence": 0-1, "evidence": string } ] }`. Evidence must quote a context entry. Only include candidates with confidence ≥ 0.6. Validate the output with zod and drop anything invalid.

## Overlay design
Bold, legible at stream scale and fun to watch:
- Jury card with a countdown bar and a live receipts/cap tally
- CALLED IT card (name, quoted call, "called 14m ago", points) with a sound
- Small rotating ticker of open calls
- Occasional "Hall of Cap" card for busted calls

Respect `prefers-reduced-motion`. No copyrighted sounds or assets; generate or use CC0 only.

## Commands
- `npm run dev` runs the server with watch
- `npm run demo` replays a scripted session (no Twitch creds)
- `npm test` runs the unit tests (scoring, jury, command parsing, judge output validation, keyword judge)
- `npm run lint`

## Definition of done for any task
The code compiles, tests pass, the README is updated if behaviour changed, `npm run demo` still works, and no secrets are committed.
