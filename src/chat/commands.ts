import { CallStore } from "../core/callStore.js";
import { containsBlockedWord } from "./filter.js";
import { sendChatMessage } from "../twitch/helix.js";
import { broadcastOverlayEvent } from "../server/overlayBus.js";
import { scoreCallBoldness } from "../judge/provider.js";
import { JuryManager } from "../core/jury.js";

export type ChatMessageEvent = {
  message_id?: string;
  message?: { text?: string };
  chatter_user_id?: string;
  chatter_user_login?: string;
  broadcaster_user_id?: string;
  badges?: Array<{ set_id: string }>;
};
type SendMessage = (text: string, replyTo?: string) => Promise<void>;

function isModerator(event: ChatMessageEvent): boolean {
  return Boolean(event.chatter_user_id && event.broadcaster_user_id && event.chatter_user_id === event.broadcaster_user_id)
    || event.chatter_user_login?.toLowerCase() === process.env.BROADCASTER_LOGIN?.toLowerCase()
    || event.badges?.some(({ set_id }) => set_id === "moderator" || set_id === "broadcaster") === true;
}

function statusLabel(status: string): string {
  return ({ open: "OPEN", correct: "CALLED IT", incorrect: "CAP", nuked: "NUKED", expired: "BUSTED" } as Record<string, string>)[status] ?? status.toUpperCase();
}

export function isHelpCommand(text: string): boolean {
  return ["!help", "!calledit"].includes(text.trim().toLowerCase());
}

function compactMessage(parts: string[], emptyMessage: string): string {
  if (!parts.length) return emptyMessage;
  let output = "";
  for (const part of parts) {
    const next = output ? `${output} | ${part}` : part;
    if (next.length > 470) break;
    output = next;
  }
  return output || `${parts[0].slice(0, 465)}…`;
}

function callSnapshot(call: { id: number; viewer_login: string; text: string; created_at: number; boldness: number }) {
  return { id: call.id, viewerLogin: call.viewer_login, text: call.text, createdAt: call.created_at, boldness: call.boldness };
}

export function formatCallConfirmation(call: { viewer_login: string; text: string; created_at: number; points_awarded: number }, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - call.created_at) / 60_000);
  const calledAgo = minutes < 1 ? "just now" : `${minutes}m ago`;
  return `@${call.viewer_login} CALLED IT ${calledAgo}: ‘${call.text}’ +${call.points_awarded} pts`;
}

function publishOpenCalls(store: CallStore): void {
  broadcastOverlayEvent({ type: "state", openCalls: store.listOpenCalls().map(callSnapshot) });
}

export function resolveCallAndBroadcast(
  store: CallStore,
  id: number,
  action: "correct" | "incorrect" | "nuked",
): ReturnType<CallStore["resolveCall"]> {
  const result = store.resolveCall(id, action);
  if (!result.ok) return result;
  publishOpenCalls(store);
  if (action === "correct") {
    const minutes = Math.floor((Date.now() - result.call.created_at) / 60_000);
    broadcastOverlayEvent({
      type: "called-it",
      viewerLogin: result.call.viewer_login,
      callText: result.call.text,
      calledAgo: minutes < 1 ? "just now" : `${minutes}m ago`,
      points: result.call.points_awarded,
    });
  } else if (action === "incorrect") {
    broadcastOverlayEvent({ type: "hall-of-cap", viewerLogin: result.call.viewer_login, callText: result.call.text });
  }
  return result;
}

export function createChatCommandHandler(
  store: CallStore,
  send: SendMessage,
  options: { expiryTimer?: boolean; scoreBoldness?: (text: string) => Promise<number>; jury?: JuryManager } = {},
): { handleChatMessage: (event: ChatMessageEvent) => Promise<void>; isJudgeEnabled: () => boolean; setJudgeEnabled: (enabled: boolean) => void; stop: () => void } {
  let judgeEnabled = true;
  const rejectedVotesWithoutJury = new Set<string>();
  const expiryTimer = options.expiryTimer === false ? undefined : setInterval(() => {
    if (store.expireCalls() > 0) publishOpenCalls(store);
  }, 15_000);
  expiryTimer?.unref();

  const reply = (event: ChatMessageEvent, text: string) => send(text.slice(0, 500), event.message_id);

  async function handleChatMessage(event: ChatMessageEvent): Promise<void> {
    const text = event.message?.text?.trim();
    const login = event.chatter_user_login;
    const viewerId = event.chatter_user_id;
    if (!text || !login || !viewerId || login.toLowerCase() === process.env.BOT_LOGIN?.toLowerCase()) return;

    try {
    if (/^!receipts$/iu.test(text) || /^!cap$/iu.test(text)) {
      const response = options.jury
        ? await options.jury.vote(viewerId, login, text.toLowerCase() === "!receipts" ? "receipts" : "cap")
        : rejectedVotesWithoutJury.has(viewerId) ? undefined : "There is no jury open right now.";
      if (!options.jury) rejectedVotesWithoutJury.add(viewerId);
      if (response) await reply(event, response);
      return;
    }

    if (/^!calledit$/iu.test(text) || /^!help$/iu.test(text)) {
      await reply(event, "Commands: !call <prediction>, !mycalls, !prophets. Vote during a jury with !receipts or !cap. Mods: !jury <id>, !yes <id>, !no <id>, !nuke <id>, !judge on/off.");
      return;
    }

    const callCommand = /^!call(?:\s+([\s\S]*))?$/iu.exec(text);
    if (callCommand) {
      const prediction = callCommand[1]?.trim() ?? "";
      const length = [...prediction].length;
      if (length < 5 || length > 120) {
        await reply(event, "A call must be 5–120 characters. Try !call <your prediction>.");
      } else if (containsBlockedWord(prediction)) {
        await reply(event, "That call contains blocked language. Please rephrase it.");
      } else {
        const boldness = options.scoreBoldness ? await options.scoreBoldness(prediction) : 2;
        const result = store.createCall({ viewerId, viewerLogin: login, text: prediction, boldness });
        if (result.ok) {
          publishOpenCalls(store);
          await reply(event, `📌 Call #${result.call.id} locked in`);
        }
        else if (result.reason === "already_open") {
          const existing = store.listViewerCalls(viewerId).find((call) => call.status === "open");
          await reply(event, `@${login} you already have an open call${existing ? ` (#${existing.id})` : ""}. Wait for it to resolve!`);
        }
        else await reply(event, "There are already 30 open calls. Try again when one resolves or expires.");
      }
      return;
    }

    if (/^!mycalls(?:\s|$)/iu.test(text)) {
      if (text.toLowerCase() !== "!mycalls") {
        await reply(event, "Usage: !mycalls");
        return;
      }
      const calls = store.listViewerCalls(viewerId);
      const lines = calls.map((call) => `#${call.id} ${statusLabel(call.status)}: ${call.text}`);
      await reply(event, compactMessage(lines, "You haven't made any calls yet. Try !call <your prediction>."));
      return;
    }

    if (/^!prophets(?:\s|$)/iu.test(text)) {
      if (text.toLowerCase() !== "!prophets") {
        await reply(event, "Usage: !prophets");
        return;
      }
      const leaders = store.getLeaderboard(5);
      const lines = leaders.map((leader, index) => `${index + 1}. ${leader.viewer_login} ${leader.points}pts`);
      await reply(event, compactMessage(lines, "No prophets yet. Be the first to call it!"));
      return;
    }

    const moderationPrefix = /^!(yes|no|nuke|jury)(?:\s|$)/iu.exec(text);
    if (moderationPrefix) {
      const action = moderationPrefix[1].toLowerCase();
      if (!isModerator(event)) {
        await reply(event, "Only the broadcaster and moderators can use that command.");
        return;
      }
      const moderation = /^!(yes|no|nuke|jury)\s+(\d+)$/iu.exec(text);
      if (!moderation || !Number.isSafeInteger(Number(moderation[2])) || Number(moderation[2]) < 1) {
        await reply(event, `Usage: !${action} <call id>`);
        return;
      }
      const [, , idText] = moderation;
      const id = Number(idText);
      if (action === "jury") {
        if (!options.jury) { await reply(event, "The jury is unavailable right now."); return; }
        const opened = await options.jury.open(id);
        if (!opened.ok) await reply(event, opened.reason === "not_found" ? `Call #${id} was not found.` : opened.reason === "not_open" ? `Call #${id} is no longer open.` : "A jury is already open. Let it finish first.");
        return;
      }
      const decision = action === "yes" ? "correct" : action === "no" ? "incorrect" : "nuked";
      options.jury?.cancel(id, false);
      const result = resolveCallAndBroadcast(store, id, decision);
      options.jury?.resumeQueue();
      if (!result.ok) {
        await reply(event, result.reason === "not_found" ? `Call #${id} was not found.` : `Call #${id} is no longer open.`);
      } else {
        if (action === "yes") {
          await reply(event, formatCallConfirmation(result.call));
        } else if (action === "no") {
          await reply(event, `❌ Call #${id} marked incorrect.`);
        } else {
          await reply(event, `🧹 Call #${id} removed.`);
        }
      }
      return;
    }

    if (/^!judge(?:\s|$)/iu.test(text)) {
      if (!isModerator(event)) {
        await reply(event, "Only the broadcaster and moderators can use !judge.");
        return;
      }
      const judge = /^!judge\s+(on|off)$/iu.exec(text);
      if (!judge) {
        await reply(event, "Usage: !judge on or !judge off");
        return;
      }
      setJudgeEnabled(judge[1].toLowerCase() === "on");
      await reply(event, `Judge is now ${judgeEnabled ? "on" : "off"}.`);
    }
    } catch {
      console.error("A chat command failed.");
      try { await reply(event, "Sorry, that command hit a snag. Please try again."); } catch { /* Twitch may also reject the fallback reply. */ }
    }
  }

  function setJudgeEnabled(enabled: boolean): void {
    judgeEnabled = enabled;
    broadcastOverlayEvent({ type: "judge:state", enabled });
  }

  return { handleChatMessage, isJudgeEnabled: () => judgeEnabled, setJudgeEnabled, stop: () => { if (expiryTimer) clearInterval(expiryTimer); } };
}

export const callStore = new CallStore(process.env.CALLED_IT_DEMO === "1" ? ":memory:" : undefined);
const juryManager = new JuryManager(callStore, broadcastOverlayEvent, sendChatMessage, (id, result) => {
  const resolved = resolveCallAndBroadcast(callStore, id, result);
  if (!resolved.ok) return false;
  return result === "correct" ? formatCallConfirmation(resolved.call) : true;
});
const defaultHandler = createChatCommandHandler(callStore, sendChatMessage, { scoreBoldness: scoreCallBoldness, jury: juryManager });
export const handleChatMessage = defaultHandler.handleChatMessage;
export const isJudgeEnabled = defaultHandler.isJudgeEnabled;
export const setJudgeEnabled = defaultHandler.setJudgeEnabled;
export function getActiveJury() {
  const jury = juryManager.getState();
  return jury ? {
    callId: jury.callId,
    viewerLogin: jury.viewerLogin,
    callText: jury.callText,
    durationMs: jury.durationMs,
    remainingMs: Math.max(0, jury.endsAt - Date.now()),
    receipts: jury.receipts,
    cap: jury.cap,
  } : undefined;
}
export async function openJury(callId: number): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_open" | "jury_active" }> {
  return juryManager.open(callId);
}
export function enqueueJury(callId: number, confidence: number): boolean {
  return juryManager.enqueue(callId, confidence);
}
export function resolveWithJuryOverride(id: number, action: "correct" | "incorrect" | "nuked") {
  juryManager.cancel(id, false);
  const result = resolveCallAndBroadcast(callStore, id, action);
  if (result.ok && action === "correct") {
    void sendChatMessage(formatCallConfirmation(result.call)).catch(() => console.error(`Could not announce confirmation for Call #${id}.`));
  }
  juryManager.resumeQueue();
  return result;
}
