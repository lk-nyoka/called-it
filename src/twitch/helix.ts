import { getAccessToken, getAccount } from "./auth.js";

const API = "https://api.twitch.tv/helix";

export async function createClipIfLive(viewerLogin: string): Promise<void> {
  if (process.env.CALLED_IT_DEMO === "1") return;
  try {
    const account = await getAccount("broadcaster");
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!account || !clientId || !account.scopes.includes("clips:edit")) return;
    const token = await getAccessToken("broadcaster");
    const headers = { Authorization: `Bearer ${token}`, "Client-Id": clientId };
    const streams = await fetch(`${API}/streams?user_id=${encodeURIComponent(account.userId)}`, { headers });
    if (!streams.ok) return;
    const live = await streams.json() as { data?: unknown[] };
    if (!live.data?.length) return;
    const query = new URLSearchParams({ broadcaster_id: account.userId, title: `Called It: @${viewerLogin}` });
    await fetch(`${API}/clips?${query}`, { method: "POST", headers });
  } catch { /* Clips are optional and never block a call resolution. */ }
}

export async function sendChatMessage(message: string, replyTo?: string): Promise<void> {
  const token = await getAccessToken("bot");
  const clientId = process.env.TWITCH_CLIENT_ID;
  const broadcaster = process.env.BROADCASTER_LOGIN?.toLowerCase();
  const bot = process.env.BOT_LOGIN?.toLowerCase();
  if (!clientId || !broadcaster || !bot) throw new Error("Set Twitch client, broadcaster and bot settings in .env.");

  const auth = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(broadcaster)}&login=${encodeURIComponent(bot)}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
  });
  if (!auth.ok) throw new Error(`Twitch user lookup failed (${auth.status}).`);
  const users = (await auth.json() as { data: Array<{ id: string; login: string }> }).data;
  const broadcasterId = users.find((user) => user.login.toLowerCase() === broadcaster)?.id;
  const botId = users.find((user) => user.login.toLowerCase() === bot)?.id;
  if (!broadcasterId || !botId) throw new Error("Twitch could not find both configured accounts.");

  const response = await fetch(`${API}/chat/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId, "Content-Type": "application/json" },
    body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: botId, message, ...(replyTo ? { reply_parent_message_id: replyTo } : {}) }),
  });
  if (!response.ok) throw new Error(`Twitch could not send the chat reply (${response.status}).`);
  const result = await response.json() as { data?: Array<{ is_sent?: boolean }> };
  if (!result.data?.[0]?.is_sent) throw new Error("Twitch did not accept the chat reply.");
}
