import type { ContextBuffer, ContextEntry } from "./context.js";

export type ChatEvidenceEvent = {
  message?: { text?: string };
  message_type?: string;
  chatter_user_id?: string;
  chatter_user_login?: string;
  chatter_is_anonymous?: boolean;
  badges?: Array<{ set_id?: string }>;
};

const KNOWN_BOTS = new Set([
  "nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "sery_bot", "serybot", "soundalerts",
]);

export function addChatEvidence(
  context: ContextBuffer,
  event: ChatEvidenceEvent,
  configuredBotLogin = process.env.BOT_LOGIN,
  now = Date.now(),
): ContextEntry | undefined {
  const text = event.message?.text?.trim();
  const login = event.chatter_user_login?.trim().toLowerCase();
  const chatterId = event.chatter_user_id;
  const configuredBots = (process.env.CHAT_BOT_LOGINS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const isBot = Boolean(login && (login === configuredBotLogin?.toLowerCase() || KNOWN_BOTS.has(login) || configuredBots.includes(login)))
    || event.badges?.some((badge) => badge.set_id?.toLowerCase() === "bot") === true;
  if (!text || !login || !chatterId || event.chatter_is_anonymous || isBot) return undefined;
  if (event.message_type && event.message_type !== "text") return undefined;
  if (/^[!/?\.]/u.test(text)) return undefined;
  return context.add("chat", text, now, now, { chatterId, chatterLogin: login, bot: false });
}
