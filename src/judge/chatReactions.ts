import type { ContextEntry } from "../core/context.js";
import type { JudgeCall } from "./types.js";

export type ChatBurstConfig = { windowMs: number; minimumChatters: number };
const DEFAULT_WINDOW_SECONDS = 5;
const DEFAULT_MIN_CHATTERS = 3;
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from", "he", "her", "him", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "she", "so", "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "with", "you", "your", "way"]);
const DEATH_WORDS = new Set(["die", "dies", "died", "dead", "death", "deaths", "kill", "kills", "killed", "killing", "rip", "eliminated"]);
const REACTION_WORDS = new Set(["no", "noo", "nooo", "omg", "wow", "what", "yikes", "bruh", "damn", "insane", "crazy", "unreal"]);

function canonicalTokens(text: string): string[] {
  const lowered = text.toLowerCase().replace(/(.)\1{2,}/gu, "$1$1");
  const tokens = lowered.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output = new Set<string>();
  for (const token of tokens) {
    if (DEATH_WORDS.has(token)) output.add("death");
    else if (REACTION_WORDS.has(token)) output.add("reaction");
    else if (token.length > 2 && !STOP_WORDS.has(token)) output.add(token);
  }
  if (/\bno+\s+way\b/iu.test(lowered)) output.add("reaction");
  return [...output];
}

function similarity(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function callOverlap(call: JudgeCall, tokens: string[]): number {
  const terms = canonicalTokens(call.text).filter((token) => token !== "reaction");
  if (!terms.length) return 0;
  return terms.filter((token) => tokens.includes(token)).length / terms.length;
}

function isGenericReaction(tokens: string[]): boolean {
  return tokens.includes("reaction");
}

function readPositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (!value || !/^\d+$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

export function getChatBurstConfig(env: NodeJS.ProcessEnv = process.env): ChatBurstConfig {
  return {
    minimumChatters: readPositiveInt(env.CHAT_BURST_MIN, DEFAULT_MIN_CHATTERS, 50),
    windowMs: readPositiveInt(env.CHAT_BURST_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS, 60) * 1_000,
  };
}

export function buildChatReactionBursts(
  call: JudgeCall,
  context: ContextEntry[],
  config: ChatBurstConfig = getChatBurstConfig(),
): ContextEntry[] {
  const eligible = context
    .filter((entry) => entry.source === "chat" && entry.timestamp > call.createdAt && entry.chatterId && entry.chatterId !== call.viewerId && !entry.bot && !/^[!/?\.]/u.test(entry.text.trim()))
    .sort((a, b) => a.timestamp - b.timestamp);
  const tokensById = new Map(eligible.map((entry) => [entry.id, canonicalTokens(entry.text)]));
  const consumed = new Set<number>();
  const bursts: ContextEntry[] = [];

  for (const anchor of eligible) {
    if (consumed.has(anchor.id)) continue;
    const anchorTokens = tokensById.get(anchor.id) ?? [];
    const window = eligible.filter((entry) => entry.timestamp >= anchor.timestamp && entry.timestamp <= anchor.timestamp + config.windowMs);
    const hasCallMatch = window.some((entry) => callOverlap(call, tokensById.get(entry.id) ?? []) >= 0.5);
    const group = window.filter((entry) => {
      const tokens = tokensById.get(entry.id) ?? [];
      return similarity(anchorTokens, tokens) >= 0.34 || (hasCallMatch && isGenericReaction(tokens));
    });
    const distinctIds = new Set(group.map((entry) => entry.chatterId));
    if (distinctIds.size < config.minimumChatters) continue;

    const phrases = new Map<string, { text: string; users: Set<string>; overlap: number }>();
    for (const entry of group) {
      const key = (tokensById.get(entry.id) ?? []).sort().join(" ") || entry.text.toLowerCase();
      const phrase = phrases.get(key) ?? { text: entry.text.trim(), users: new Set<string>(), overlap: callOverlap(call, tokensById.get(entry.id) ?? []) };
      if (entry.chatterId) phrase.users.add(entry.chatterId);
      if (entry.text.trim().length > phrase.text.length) phrase.text = entry.text.trim();
      phrases.set(key, phrase);
    }
    const representative = [...phrases.values()].sort((a, b) => b.overlap - a.overlap || b.users.size - a.users.size || b.text.length - a.text.length)[0];
    if (!representative) continue;
    for (const entry of group) consumed.add(entry.id);
    const id = -(call.id * 1_000 + bursts.length + 1);
    const t = Math.max(...group.map((entry) => entry.timestamp));
    const quote = representative.text.length > 300 ? `${representative.text.slice(0, 297)}…` : representative.text;
    bursts.push({
      id,
      timestamp: t,
      source: "chat",
      text: `${distinctIds.size} chatters: “${quote}”`,
      callId: call.id,
      chatters: distinctIds.size,
    });
  }
  return bursts;
}
