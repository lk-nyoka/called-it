# Called It 

**Every chat has prophets. Now they get receipts.**

Called It lets Twitch viewers make free-text predictions in chat (`!call he rage-quits before the boss`). An AI judge listens to the stream, and when a call looks like it came true, chat decides in a 10-second jury: **RECEIPTS** or **CAP**. Confirmed calls get a "CALLED IT" moment on stream, a clip, and points on the Prophets leaderboard.

- Works for any channel: no Affiliate, Channel Points or Bits needed
- Runs locally and free: EventSub over WebSocket, no hosting
- AI judge with a no-key keyword fallback

Built with OpenAI Codex for the Codex x TwitchCon Hackathon.

> 🚧 Work in progress. Setup and run instructions are coming as the build lands.

See [`AGENTS.md`](AGENTS.md) for the full spec and [`docs/CODEX_PLAN.md`](docs/CODEX_PLAN.md) for the build plan.
