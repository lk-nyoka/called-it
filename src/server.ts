import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { z } from "zod";
import { completeAuthorization, createAuthorizationUrl, getAccount, type TwitchRole } from "./twitch/auth.js";
import { startEventSub } from "./twitch/eventsub.js";
import { attachOverlayBus, broadcastOverlayEvent } from "./server/overlayBus.js";
import { callStore, enqueueJury, getActiveJury, isJudgeEnabled, openJury, resolveWithJuryOverride, setJudgeEnabled } from "./chat/commands.js";
import { contextBuffer } from "./core/context.js";
import { activeProvider } from "./judge/provider.js";
import { JudgeScheduler } from "./judge/scheduler.js";
import { sendChatMessage } from "./twitch/helix.js";
import { createJudgeAnnouncementPublisher } from "./judge/announcement.js";

export const app = express();
app.use(express.json({ limit: "8kb" }));

const judgeScheduler = new JudgeScheduler({
  store: callStore,
  context: contextBuffer,
  provider: activeProvider,
  isEnabled: isJudgeEnabled,
  publish: createJudgeAnnouncementPublisher(
    (suggestions) => broadcastOverlayEvent({ type: "judge:suggestions", suggestions }),
    sendChatMessage,
    (suggestion) => {
      const queued = enqueueJury(suggestion.callId, suggestion.confidence);
      return getActiveJury()?.callId === suggestion.callId ? "opened" : queued ? "queued" : undefined;
    },
  ),
});

function requireSameOrigin(request: Request, response: Response, next: NextFunction): void {
  const origin = request.get("origin");
  if (origin) {
    try {
      const expectedOrigin = new URL(`${request.protocol}://${request.get("host")}`).origin;
      if (new URL(origin).origin !== expectedOrigin) {
        response.status(403).json({ error: "This local control is only available from the Called It page." });
        return;
      }
    } catch {
      response.status(403).json({ error: "This local control is only available from the Called It page." });
      return;
    }
  }
  next();
}

async function startIfAuthorized(): Promise<void> {
  const [bot, broadcaster] = await Promise.all([getAccount("bot"), getAccount("broadcaster")]);
  if (bot && broadcaster) await startEventSub();
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

const consoleDirectory = path.resolve("web/console");
app.get("/console", (_request, response) => response.sendFile(path.join(consoleDirectory, "index.html")));
app.use("/console", express.static(consoleDirectory));

app.get("/api/console/state", (_request, response) => {
  response.json({
    openCalls: callStore.listOpenCalls().map((call) => ({ id: call.id, viewerLogin: call.viewer_login, text: call.text, createdAt: call.created_at, boldness: call.boldness })),
    context: contextBuffer.recent(),
    judgeEnabled: isJudgeEnabled(),
    judgeSuggestions: judgeScheduler.getSuggestions(),
    activeJury: getActiveJury() ?? null,
  });
});

app.post("/api/context/speech", requireSameOrigin, (request, response) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(500), timestamp: z.number().int() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Send a sentence and its timestamp." });
  if (Math.abs(Date.now() - parsed.data.timestamp) > 60_000) return response.status(400).json({ error: "That transcript timestamp is too far from the current time." });
  const entry = contextBuffer.add("speech", parsed.data.text, parsed.data.timestamp);
  broadcastOverlayEvent({ type: "context", entry });
  response.status(201).json({ entry });
});

app.post("/api/calls/:id/action", requireSameOrigin, (request, response) => {
  const id = Number(request.params.id);
  const parsed = z.object({ action: z.enum(["confirm", "reject", "nuke"]) }).safeParse(request.body);
  if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) return response.status(400).json({ error: "Choose a call and a valid action." });
  const action = parsed.data.action === "confirm" ? "correct" : parsed.data.action === "reject" ? "incorrect" : "nuked";
  const result = resolveWithJuryOverride(id, action);
  if (!result.ok) return response.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason === "not_found" ? `Call #${id} was not found.` : `Call #${id} is no longer open.` });
  response.json({ call: { id: result.call.id, status: result.call.status, points: result.call.points_awarded } });
});

app.post("/api/jury/:id/open", requireSameOrigin, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Choose a valid call." });
  const result = await openJury(id);
  if (!result.ok) return response.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason === "not_found" ? `Call #${id} was not found.` : result.reason === "not_open" ? `Call #${id} is no longer open.` : "A jury is already open." });
  response.status(201).json({ activeJury: getActiveJury() });
});

app.post("/api/judge", requireSameOrigin, (request, response) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Choose whether the judge is on or off." });
  setJudgeEnabled(parsed.data.enabled);
  response.json({ enabled: isJudgeEnabled() });
});

const overlayDirectory = path.resolve("web/overlay");
app.get("/overlay", (_request, response) => response.sendFile(path.join(overlayDirectory, "index.html")));
app.use("/overlay", express.static(overlayDirectory));

app.get("/auth/callback", async (request, response) => {
  const { state, code, error } = request.query;
  if (error) return response.status(400).send("Twitch authorization was not granted. Return to the app and try again.");
  if (typeof state !== "string" || typeof code !== "string") return response.status(400).send("Twitch callback is missing its login state or code.");
  try {
    const role = await completeAuthorization(state, code);
    await startIfAuthorized();
    response.send(`<h1>Called It connected ${role} account.</h1><p>You can close this tab and return to your Twitch chat.</p>`);
  } catch (error) {
    response.status(400).send(error instanceof Error ? error.message : "Twitch login failed.");
  }
});

app.get("/auth/status", async (_request, response) => {
  response.json({ bot: await getAccount("bot"), broadcaster: await getAccount("broadcaster") });
});

app.get("/auth/:role", (request, response) => {
  const role = request.params.role as TwitchRole;
  if (role !== "bot" && role !== "broadcaster") return response.status(404).send("Use /auth/bot or /auth/broadcaster.");
  try {
    response.redirect(createAuthorizationUrl(role));
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "Could not start Twitch login.");
  }
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, "localhost", () => {
    console.log(`Called It server listening at http://localhost:${port}`);
    void startIfAuthorized().catch((error: Error) => console.error(error.message));
  });
  attachOverlayBus(server, () => callStore.listOpenCalls().map((call) => ({
    id: call.id,
    viewerLogin: call.viewer_login,
    text: call.text,
    createdAt: call.created_at,
    boldness: call.boldness,
  })), getActiveJury);
  judgeScheduler.start();
}
