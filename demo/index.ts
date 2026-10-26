import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CallStore } from "../src/core/callStore.js";
import { addChatEvidence } from "../src/core/chatEvidence.js";
import { ContextBuffer } from "../src/core/context.js";
import { JuryManager } from "../src/core/jury.js";
import { KeywordJudge } from "../src/judge/keyword.js";
import { createJudgeAnnouncementPublisher } from "../src/judge/announcement.js";
import { JudgeScheduler } from "../src/judge/scheduler.js";
import { attachOverlayBus, broadcastOverlayEvent } from "../src/server/overlayBus.js";
import type { ChatMessageEvent } from "../src/chat/commands.js";

const PORT = Number(process.env.PORT ?? 3000);
const SPEED = 8;
const JURY_MS = 10_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const overlayDirectory = path.resolve(here, "../web/overlay");
const consoleDirectory = path.resolve(here, "../web/console");
let storyTime = 0;
const demoClockOrigin = Date.now() - 12 * 60_000;
const demoNow = () => demoClockOrigin + storyTime;

process.env.CALLED_IT_DEMO = "1";
const { createChatCommandHandler, resolveCallAndBroadcast, formatCallConfirmation } = await import("../src/chat/commands.js");

const store = new CallStore(":memory:");
const context = new ContextBuffer();
const app = express();
app.get("/health", (_request, response) => response.json({ status: "ok", mode: "demo" }));
app.get("/overlay", (_request, response) => response.sendFile(path.join(overlayDirectory, "index.html")));
app.use("/overlay", express.static(overlayDirectory));
app.get("/console", (_request, response) => response.sendFile(path.join(consoleDirectory, "index.html")));
app.use("/console", express.static(consoleDirectory));

const server = createServer(app);
let jury!: JuryManager;
const openCalls = () => store.listOpenCalls().map((call) => ({
  id: call.id,
  viewerLogin: call.viewer_login,
  text: call.text,
  createdAt: call.created_at,
  boldness: call.boldness,
}));
const activeJury = () => {
  const state = jury?.getState();
  return state ? {
    callId: state.callId,
    viewerLogin: state.viewerLogin,
    callText: state.callText,
    durationMs: state.durationMs,
    remainingMs: Math.max(0, state.endsAt - Date.now()),
    receipts: state.receipts,
    cap: state.cap,
  } : undefined;
};
const sockets = attachOverlayBus(server, openCalls, activeJury);

function logChat(message: string): Promise<void> {
  console.log(`  [BOT] ${message}`);
  return Promise.resolve();
}

jury = new JuryManager(
  store,
  broadcastOverlayEvent,
  logChat,
  (id, result) => {
    const resolved = resolveCallAndBroadcast(store, id, result, demoNow());
    if (!resolved.ok) return false;
    return result === "correct" ? formatCallConfirmation(resolved.call, demoNow()) : true;
  },
  JURY_MS,
);

const commandHandler = createChatCommandHandler(store, logChat, {
  expiryTimer: false,
  scoreBoldness: async () => 2,
  now: demoNow,
  jury,
});
const keywordJudge = new KeywordJudge();
const scheduler = new JudgeScheduler({
  store,
  context,
  provider: keywordJudge,
  isEnabled: () => true,
  publish: createJudgeAnnouncementPublisher(
    (suggestions) => broadcastOverlayEvent({ type: "judge:suggestions", suggestions }),
    logChat,
    (suggestion) => {
      const queued = jury.enqueue(suggestion.callId, suggestion.confidence);
      if (queued) {
        console.log(`  [JUDGE] Queued Call #${suggestion.callId} (${Math.round(suggestion.confidence * 100)}% confidence).`);
      }
      return jury.getState()?.callId === suggestion.callId ? "opened" : queued ? "queued" : undefined;
    },
  ),
});

app.get("/api/console/state", (_request, response) => {
  response.json({
    openCalls: openCalls(),
    context: context.recent(),
    judgeEnabled: true,
    judgeSuggestions: scheduler.getSuggestions(),
    activeJury: activeJury() ?? null,
  });
});

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const waitVirtual = (milliseconds: number) => wait(milliseconds / SPEED);

function stage(message: string): void {
  const minutes = Math.floor(storyTime / 60_000).toString().padStart(2, "0");
  const seconds = Math.floor((storyTime % 60_000) / 1_000).toString().padStart(2, "0");
  console.log(`[${minutes}:${seconds}] ${message}`);
}

async function fakeChat(login: string, userId: string, text: string): Promise<void> {
  console.log(`  [CHAT] ${login}: ${text}`);
  const event = {
    message_type: "text",
    message: { text },
    chatter_user_id: userId,
    chatter_user_login: login,
  };
  const entry = addChatEvidence(context, event, "calleditbot");
  if (entry) broadcastOverlayEvent({ type: "context", entry });
  const commandEvent: ChatMessageEvent = {
    message_id: `demo-${Date.now()}-${userId}`,
    message: { text },
    chatter_user_id: userId,
    chatter_user_login: login,
    broadcaster_user_id: "demo-broadcaster",
    badges: [],
  };
  await commandHandler.handleChatMessage(commandEvent);
}

async function waitForJury(callId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (jury.getState()?.callId === callId) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for Call #${callId}'s jury.`);
}

async function runSession(): Promise<void> {
  console.log("Called It · scripted four-minute replay (8× fast-forward; jury timers stay real-time)");
  console.log(`Overlay: http://localhost:${PORT}/overlay`);
  console.log("Fake Twitch chat is printed here. No Twitch login, API key, or .env is needed.\n");

  stage("Cold open: two viewers make predictions.");
  await fakeChat("pixelprophet", "viewer-pixel", "!call the boss dies before the timer");
  await fakeChat("chatoracle", "viewer-chat", "!call Mira finds the golden key");
  storyTime = 15_000;
  await waitVirtual(45_000);
  storyTime = 60_000;

  stage("Streamer transcript: Mira looked for the golden key but did not find it.");
  const transcript = "Mira looked for the golden key but did not find it.";
  const transcriptEntry = context.add("speech", transcript);
  broadcastOverlayEvent({ type: "context", entry: transcriptEntry });
  console.log(`  [MIC] ${transcript}`);

  stage("Four different chatters react within five seconds.");
  const burst = [
    ["viewer-one", "reactor1", "the boss died before the timer"],
    ["viewer-two", "reactor2", "he died"],
    ["viewer-three", "reactor3", "NOOO"],
    ["viewer-four", "reactor4", "no way he did it"],
  ] as const;
  for (const [login, id, text] of burst) {
    await fakeChat(login, id, text);
    await wait(180);
  }

  stage("Keyword judge evaluates transcript plus distinct-chatter burst evidence; it is unsure about Call #2.");
  const suggestions = await scheduler.runOnce();
  if (suggestions.length !== 2) throw new Error(`Expected two judge flags, got ${suggestions.length}.`);
  await waitForJury(1);
  stage("Call #1 jury opens automatically; Call #2 waits in the one-at-a-time queue.");
  await wait(700);
  await fakeChat("receiptfan1", "voter-r1", "!receipts");
  await fakeChat("receiptfan2", "voter-r2", "!receipts");
  storyTime = 12 * 60_000;
  await wait(JURY_MS + 250);
  if (store.getCall(1)?.status !== "correct") throw new Error("Call #1 did not resolve as CALLED IT.");

  await waitForJury(2);
  stage("Call #1 is CALLED IT; the queued Call #2 jury opens.");
  await wait(700);
  await fakeChat("capfan1", "voter-c1", "!cap");
  await fakeChat("capfan2", "voter-c2", "!cap");
  storyTime += 80_000;
  await wait(JURY_MS + 250);
  if (store.getCall(2)?.status !== "incorrect") throw new Error("Call #2 did not resolve as Hall of Cap.");
  stage("The judge was unsure about Call #2; chat voted CAP.");

  storyTime = 240_000;
  await waitVirtual(5_000);
  stage("Four-minute replay complete: one CALLED IT, one CAP. The overlay server stays open.");
  console.log("Keep the overlay open to inspect the final moment. Press Ctrl+C here to stop the demo.\n");
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "localhost", resolve);
  });
  console.log(`Demo server listening at http://localhost:${PORT}`);
  process.once("SIGINT", () => {
    console.log("\nStopping Called It demo…");
    const active = jury.getState();
    if (active) jury.cancel(active.callId, false);
    commandHandler.stop();
    scheduler.stop();
    for (const client of sockets.clients) client.close();
    sockets.close();
    server.close();
    store.close();
    process.exit(0);
  });
  await runSession();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The demo session failed.");
  process.exitCode = 1;
  server.close();
  commandHandler.stop();
  store.close();
});
