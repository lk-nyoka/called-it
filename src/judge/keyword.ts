import type { JudgeInput, JudgeOutput, JudgeProvider } from "./types.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "by", "for", "from", "he", "her", "hers", "him", "his",
  "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their",
  "them", "they", "this", "to", "we", "was", "were", "will", "with", "you", "your", "next", "within", "minute", "minutes", "min",
  "mins", "hour", "hours", "hr", "hrs", "second", "seconds", "sec", "secs",
]);
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NEGATORS = new Set(["not", "never", "no", "nothing", "didn't", "didn’t", "doesn't", "doesn’t", "isn't", "isn’t", "wasn't", "wasn’t", "weren't", "weren’t", "won't", "won’t", "can't", "can’t", "cannot", "without", "failed"]);

function normalize(token: string): string {
  let word = token.toLowerCase();
  const irregular: Record<string, string> = { dies: "die", died: "die", dying: "die", dead: "die", death: "die", deaths: "die", killed: "kill", kills: "kill", killing: "kill" };
  if (irregular[word]) return irregular[word]!;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      word = word.slice(0, -suffix.length);
      if ((suffix === "ing" || suffix === "ed") && /(.)\1$/u.test(word)) word = word.slice(0, -1);
      break;
    }
  }
  return word;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []).map(normalize);
}

function keyTerms(text: string): string[] {
  return [...new Set(words(withoutTimeLimit(text)).filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

function withoutTimeLimit(text: string): string {
  return text.replace(/\b(?:in|within)\s+(?:the\s+)?(?:next\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/giu, " ");
}

function timeLimitMs(text: string): number | undefined {
  const match = /\b(?:in|within)\s+(?:the\s+)?(?:next\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/iu.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]) || NUMBER_WORDS[match[1].toLowerCase()];
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("sec") ? 1_000 : unit.startsWith("min") ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function hasNearbyNegation(tokens: string[], index: number): boolean {
  return tokens.slice(Math.max(0, index - 4), index).some((token) => NEGATORS.has(token));
}

function confidenceFor(callText: string, contextText: string): number | undefined {
  const terms = keyTerms(callText);
  const tokens = words(contextText);
  if (terms.length === 0) return undefined;
  const matched = terms.filter((term) => {
    const index = tokens.indexOf(term);
    return index >= 0 && !hasNearbyNegation(tokens, index);
  });
  const minimumMatches = terms.length === 1 ? 1 : Math.max(2, Math.ceil(terms.length * 0.4));
  if (matched.length < minimumMatches) return undefined;
  return Math.min(0.95, 0.6 + (matched.length / terms.length) * 0.35);
}

export class KeywordJudge implements JudgeProvider {
  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const candidates = [];
    for (const call of input.calls) {
      const deadline = timeLimitMs(call.text);
      let best: { confidence: number; evidence: string } | undefined;
      for (const entry of input.context) {
        if (entry.t <= call.createdAt) continue;
        if (deadline !== undefined && entry.t > call.createdAt + deadline) continue;
        if (entry.callId !== undefined && entry.callId !== call.id) continue;
        if (entry.source === "chat" && (entry.chatters === undefined || entry.chatters < 3)) continue;
        if (entry.chatterId && entry.chatterId === call.viewerId) continue;
        if (entry.bot || /^[!/?\.]/u.test(entry.text.trim())) continue;
        const message = entry.source === "chat" ? /^\d+ chatters: “([\s\S]+)”$/u.exec(entry.text)?.[1] : entry.text;
        if (!message) continue;
        const rawConfidence = confidenceFor(call.text, message);
        const confidence = rawConfidence === undefined ? undefined : entry.source === "chat" ? Math.max(0.8, rawConfidence) : rawConfidence;
        if (confidence !== undefined && (!best || confidence > best.confidence)) best = { confidence, evidence: entry.text };
      }
      if (best && best.confidence >= 0.6) candidates.push({ callId: call.id, ...best });
    }
    return { candidates };
  }

  async scoreBoldness(_text: string): Promise<number> {
    return 2;
  }
}
