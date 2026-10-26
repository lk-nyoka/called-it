import WebSocket from "ws";
import { getAccessToken } from "./auth.js";
import { callStore, handleChatMessage } from "../chat/commands.js";
import { contextBuffer } from "../core/context.js";
import { addChatEvidence } from "../core/chatEvidence.js";
import { broadcastOverlayEvent } from "../server/overlayBus.js";

const DEFAULT_URL = "wss://eventsub.wss.twitch.tv/ws";
let activeSocket: WebSocket | undefined;
let starting = false;
let streamStartedAt = Date.now();
const recentChatMessageIds = new Set<string>();

function rememberChatMessage(id: string): boolean {
  if (recentChatMessageIds.has(id)) return false;
  recentChatMessageIds.add(id);
  if (recentChatMessageIds.size > 2_000) recentChatMessageIds.delete(recentChatMessageIds.values().next().value!);
  return true;
}

async function subscribe(sessionId: string): Promise<void> {
  const token = await getAccessToken("bot");
  const clientId = process.env.TWITCH_CLIENT_ID;
  const broadcaster = process.env.BROADCASTER_LOGIN?.toLowerCase();
  const bot = process.env.BOT_LOGIN?.toLowerCase();
  if (!clientId || !broadcaster || !bot) throw new Error("Set TWITCH_CLIENT_ID, BROADCASTER_LOGIN and BOT_LOGIN in .env.");
  const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(broadcaster)}&login=${encodeURIComponent(bot)}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
  });
  if (!response.ok) throw new Error(`Twitch user lookup failed (${response.status}).`);
  const users = (await response.json() as { data: Array<{ id: string; login: string }> }).data;
  const broadcasterId = users.find((user) => user.login.toLowerCase() === broadcaster)?.id;
  const botId = users.find((user) => user.login.toLowerCase() === bot)?.id;
  if (!broadcasterId || !botId) throw new Error("Twitch could not find both configured accounts.");

  const createSubscription = (type: string, version: string, condition: Record<string, string>) => fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId, "Content-Type": "application/json" },
    body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: sessionId } }),
  });
  const [chatSubscription, raidSubscription, streamOnlineSubscription, streamOfflineSubscription] = await Promise.all([
    createSubscription("channel.chat.message", "1", { broadcaster_user_id: broadcasterId, user_id: botId }),
    createSubscription("channel.raid", "1", { to_broadcaster_user_id: broadcasterId }),
    createSubscription("stream.online", "1", { broadcaster_user_id: broadcasterId }),
    createSubscription("stream.offline", "1", { broadcaster_user_id: broadcasterId }),
  ]);
  if (!chatSubscription.ok) throw new Error(`Twitch could not subscribe to channel chat (${chatSubscription.status}). Check bot chat access and both authorizations.`);
  if (!raidSubscription.ok) console.warn(`Called It could not subscribe to incoming raids (${raidSubscription.status}); chat will continue normally.`);
  if (!streamOnlineSubscription.ok) console.warn(`Called It could not subscribe to stream starts (${streamOnlineSubscription.status}); recap will cover this app session.`);
  if (!streamOfflineSubscription.ok) console.warn(`Called It could not subscribe to stream end (${streamOfflineSubscription.status}); no automatic session recap will appear.`);
  // channel.follow requires moderator:read:followers, which the current tokens do not have.
}

function connect(url = DEFAULT_URL, isReconnect = false): void {
  const socket = new WebSocket(url);
  let keepalive: NodeJS.Timeout | undefined;

  const armKeepalive = (seconds: number) => {
    if (keepalive) clearTimeout(keepalive);
    keepalive = setTimeout(() => socket.close(), (seconds + 5) * 1000);
  };
  socket.on("message", (raw) => {
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const type = data.metadata?.message_type;
    if (type === "session_welcome") {
      const previousSocket = activeSocket;
      activeSocket = socket;
      const sessionId = data.payload?.session?.id;
      const timeout = data.payload?.session?.keepalive_timeout_seconds;
      if (typeof timeout === "number") armKeepalive(timeout);
      if (!isReconnect && sessionId) void subscribe(sessionId).catch((error: Error) => console.error(error.message));
      else if (isReconnect) previousSocket?.close();
    } else if (type === "session_keepalive") {
      const timeout = data.payload?.session?.keepalive_timeout_seconds;
      if (typeof timeout === "number") armKeepalive(timeout);
    } else if (type === "session_reconnect") {
      const reconnectUrl = data.payload?.session?.reconnect_url;
      if (typeof reconnectUrl === "string") connect(reconnectUrl, true);
    } else if (type === "notification" && data.payload?.subscription?.type === "channel.chat.message") {
      const event = data.payload.event;
      const messageId = event?.message_id;
      if (typeof messageId !== "string" || rememberChatMessage(messageId)) {
        const entry = addChatEvidence(contextBuffer, event);
        if (entry) broadcastOverlayEvent({ type: "context", entry });
        void handleChatMessage(event).catch((error: Error) => console.error(error.message));
      }
    } else if (type === "notification" && data.payload?.subscription?.type === "channel.raid") {
      const event = data.payload.event;
      const entry = contextBuffer.add("event", `${event.from_broadcaster_user_name} raided with ${event.viewers} viewers.`);
      broadcastOverlayEvent({ type: "context", entry });
    } else if (type === "notification" && data.payload?.subscription?.type === "stream.online") {
      const startedAt = Date.parse(data.payload.event?.started_at);
      streamStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
    } else if (type === "notification" && data.payload?.subscription?.type === "stream.offline") {
      broadcastOverlayEvent({ type: "session:recap", recap: callStore.getSessionRecap(streamStartedAt) });
      streamStartedAt = Date.now();
    }
  });
  socket.on("close", () => {
    if (keepalive) clearTimeout(keepalive);
    if (activeSocket === socket) {
      activeSocket = undefined;
      setTimeout(() => { if (!activeSocket) connect(); }, 3000);
    }
  });
  socket.on("error", () => socket.close());
}

export async function startEventSub(): Promise<void> {
  if (starting || activeSocket) return;
  starting = true;
  try {
    await getAccessToken("bot");
    connect();
  } finally {
    starting = false;
  }
}
