# Called It: Codex build plan

**Hackathon:** Codex x TwitchCon. Submit by **Sun 2 Nov, 23:59 SAST** (the official deadline is 3 Nov 00:00 GMT+2).
**Rule that matters:** build in **one Codex thread** and submit its session ID (type `/status` in Codex).

---

## 0. Setup (about 1 hour, do this first)

- [ ] Create a GitHub repo `called-it` (private is fine; share it with testing@devpost.com before you submit).
- [ ] Put `AGENTS.md` from this pack in the repo root. Codex reads it automatically.
- [ ] Twitch: create a second account for the bot (e.g. `calleditbot`), or use your own account for testing.
- [ ] Register an app at dev.twitch.tv/console:
  - Redirect URL `http://localhost:3000/auth/callback`
  - Category: Chat Bot
  - Copy the Client ID and Secret into `.env` (never into chat with Codex)
- [ ] Install Node 20+, OBS and Chrome.
- [ ] Sign in to Codex, start **one new thread**, connect the repo, and keep using that thread for the whole build.
- [ ] Optional: get an OpenAI API key for the AI judge. Keyword mode works without one.
- [ ] Line up 3–4 friends (or alt accounts in separate browser profiles) to be "chat" for the demo.

---

## 1. Schedule

| Day | Date | Work | Prompts |
|---|---|---|---|
| 1 | Tue 28 Oct | Scaffold, Twitch auth, chat in/out | 1–2 |
| 2 | Wed 29 Oct | Calls, storage, commands | 3 |
| 3 | Thu 30 Oct | Overlay and console with speech | 4–5 |
| 4 | Fri 31 Oct | Judge, jury and scoring (keep time free for the UJ deadline) | 6–7 |
| 5 | Sat 1 Nov | Clips, polish, demo mode, tests | 8–9 |
| 6 | Sun 2 Nov | Hardening, live test stream, record video, submit | 10 + submission |

Mon 27 Oct is reserved for finishing Inside the Game. Do the setup in section 0 on Monday evening if you have time.

---

## 2. Codex prompts (paste in order, same thread)

Make sure each prompt passes before you send the next. If something breaks, tell Codex the exact error and nothing else.

**Prompt 1: Scaffold**
> Read AGENTS.md. Scaffold the project exactly as described: TypeScript ESM, express, ws, better-sqlite3, zod, vitest, dotenv. Create the folder structure (`src/…`, `web/`, `demo/`, `data/` gitignored), `.env.example`, npm scripts (`dev`, `demo`, `test`, `lint`), and a README stub. Add a `/health` route. Don't implement Twitch yet. Show me how to run it.

**Prompt 2: Twitch auth and chat**
> Implement `twitch/auth.ts` (OAuth authorization code flow with a local callback, token storage in data/tokens.json, auto refresh), `twitch/eventsub.ts` (EventSub WebSocket: connect, handle the welcome/keepalive/reconnect messages, subscribe to channel.chat.message for BROADCASTER_LOGIN as the bot user), and `twitch/helix.ts` sendChatMessage. Check scopes and payloads against the current dev.twitch.tv docs and list the exact scopes you chose and why. Acceptance: when I type `!calledit` in my channel, the bot replies with a one-line help message.

**Prompt 3: Calls and commands**
> Implement `core/callStore.ts` (SQLite schema for calls and the leaderboard) and `chat/commands.ts` following the game rules in AGENTS.md: `!call` (validation, blocklist filter, one open call per viewer, global cap, reply "📌 Call #12 locked in"), `!mycalls`, `!prophets` (top 5), and the mod/broadcaster-only commands `!yes`, `!no`, `!nuke`, `!judge on|off`. Expire calls on a timer. Add vitest tests for parsing, the limits and permission checks.

**Prompt 4: Overlay and WebSocket bus**
> Build the local WS bus and `web/overlay` as an OBS Browser Source (1920x1080, transparent background). Components: an open-calls ticker (bottom), a jury card with a 10s countdown bar and a live receipts/cap tally, a CALLED IT celebration card (viewer name, quoted call, "called Xm ago", points), and a Hall of Cap card for busted calls. Make it bold and legible at stream scale and genuinely fun to watch, respect prefers-reduced-motion, and synthesize sounds with the Web Audio API (no copyrighted assets). Add a `/overlay?test=1` mode that cycles through every state so I can style it in OBS.

**Prompt 5: Streamer console and speech**
> Build `web/console` for Chrome. It should:
> - Capture the streamer's mic with the Web Speech API (continuous, interim results off, auto restart on end) and send final transcript lines to the server, where they go into the rolling context window
> - Show the open calls, the judge candidates, and buttons for Confirm / Reject / Nuke plus a judge on/off toggle
> - Show a live transcript so I can see what the judge hears
> - Feed EventSub follow/raid/sub events into the context too, wherever my token scopes allow; skip the ones that need Affiliate and log that clearly

**Prompt 6: AI judge**
> Implement `judge/` with the JudgeProvider interface and the judge contract from AGENTS.md:
> - Every 15s, if there are open calls and new context, call the provider
> - `keyword.ts`: entity/keyword overlap plus simple time phrases, no API key
> - `openai.ts`: a small, cheap model with JSON output, a strict system prompt, zod validation, a timeout, and fallback to keyword on error
> - Also judge boldness (1–5) when a call is created
> - Never use context from before the call's creation time
>
> Write tests with fixed fixtures for: clearly true, clearly false, partially true, and evidence that came before the call (must be rejected).

**Prompt 7: Jury, resolution and scoring**
> Implement `core/jury.ts` and `core/scoring.ts` per AGENTS.md:
> - One jury at a time; queue the rest
> - Count `!receipts` / `!cap` once per viewer, and the call's author can't vote
> - Apply the thresholds, the zero-vote fallback and the streamer veto from the console
> - On a correct call: award points, push CALLED IT to the overlay, and post in chat "🔮 @name CALLED IT 14m ago: '<call>' +40 pts"
> - On a rejection: push a short "CAP" overlay
>
> Add tests for the jury math and scoring.

**Prompt 8: Clips and polish**
> When a call is confirmed, create a Twitch clip with Helix Create Clip (only if the stream is live and the scope was granted; handle errors quietly) and post the clip link in chat. Add `!prophets` overlay mode, which shows the leaderboard card for 8s. Polish the overlay animations and timing so a jury plus celebration takes under 15s in total. Add a session summary at stream end (most bold correct call, biggest cap).

**Prompt 9: Demo mode, tests and README**
> Build `npm run demo`: a scripted replay of a 4-minute session (fake viewers making calls, transcript lines, events, jury votes) driven through the REAL pipeline using the keyword judge, with the overlay at localhost:3000/overlay so judges can watch it without Twitch credentials. Then write the README: what it is, a GIF placeholder, quick start (demo mode), full setup (Twitch app, scopes, .env, OBS browser source, console in Chrome), how the judge works, how Codex was used, and known limits. Make sure `npm test` passes.

**Prompt 10: Hardening**
> Review the whole codebase as if you were a hackathon judge testing it cold. Fix:
> - EventSub reconnect handling
> - Token refresh races
> - Rate limits on sending chat
> - Overlay WS reconnect
> - Any path where unfiltered viewer text could reach the overlay
> - Behaviour when the OpenAI key is missing
>
> Then list anything you couldn't fix.

---

## 3. Live test (Sunday morning)

1. Start the server, open the console in Chrome (allow the mic) and add the overlay to OBS as a Browser Source.
2. Go live with any free game or Just Chatting, with your friends in chat.
3. Have the friends make calls that are likely to come true, e.g. "he says 'no way' in the next 5 min" or "he dies within 2 minutes". Make one bold call too.
4. Check that juries fire, celebrations look good and clips get created. Fix anything urgent in the same Codex thread.

---

## 4. Demo video (max 3:00, public on YouTube)

| Time | Shot |
|---|---|
| 0:00–0:15 | Hook: a real "CALLED IT" moment with the clip playing. "This viewer predicted that 14 minutes before it happened." |
| 0:15–0:35 | The problem: Twitch Predictions are streamer-made with fixed outcomes and settled by hand. Viewers can't make their own calls, and nobody remembers who called it. |
| 0:35–1:40 | Live on Twitch: `!call` → bot confirms → the moment happens → the AI flags it → chat jury → celebration → leaderboard. Include one CAP moment. |
| 1:40–2:10 | Under the hood: speech plus EventSub → judge → jury. Free keyword mode, no Affiliate needed, runs locally. |
| 2:10–2:45 | How Codex built it: show the thread, AGENTS.md, and 2–3 prompts with results (e.g. the EventSub reconnect fix and the test fixtures). |
| 2:45–3:00 | Close: "Every chat has prophets. Now they get receipts." |

---

## 5. Submission checklist
- [ ] Repo has all source code, assets and a README with run instructions; `npm run demo` works on a clean clone
- [ ] If the repo is private, it's shared with testing@devpost.com
- [ ] The YouTube video is public, under 3:00, and shows it working on Twitch and how you used Codex
- [ ] The description covers features, how it works and how Codex was used
- [ ] The Codex session ID comes from the main thread (`/status`)
- [ ] Submitted by Sunday evening, not at 23:58

## 6. Risks and fallbacks

| Risk | Fallback |
|---|---|
| The AI judge is slow or wrong | The chat jury and streamer veto decide; keyword mode works offline |
| Speech recognition picks up game audio | Use a headset mic; the console only listens to the mic |
| Not enough chatters for the demo | Friends plus alt accounts; demo mode for the walkthrough part |
| Clip creation fails | It's optional; the celebration still plays |
| Scope or endpoint confusion | Prompt 2 forces Codex to check the docs and explain the scopes |
