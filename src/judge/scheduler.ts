import type { CallStore } from "../core/callStore.js";
import type { ContextBuffer, ContextEntry } from "../core/context.js";
import { buildChatReactionBursts } from "./chatReactions.js";
import { JudgeCandidateSchema, parseJudgeOutput, type JudgeCall, type JudgeProvider, type JudgeSuggestion } from "./types.js";

const INTERVAL_MS = 15_000;

export function validateSuggestions(
  output: unknown,
  calls: JudgeCall[],
  context: ContextEntry[],
): JudgeSuggestion[] {
  let candidates: unknown[];
  try { candidates = parseJudgeOutput(output).candidates; } catch { return []; }
  const validCalls = new Map(calls.map((call) => [call.id, call]));
  const suggestions = new Map<number, JudgeSuggestion>();
  for (const candidate of candidates) {
    const parsed = JudgeCandidateSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.confidence < 0.6) continue;
    const call = validCalls.get(parsed.data.callId);
    if (!call) continue;
    const evidenceEntry = context
      .filter((entry) => entry.timestamp > call.createdAt
        && (entry.callId === undefined || entry.callId === call.id)
        && (entry.source !== "chat" || (entry.chatters !== undefined && entry.chatters >= 3))
        && entry.text === parsed.data.evidence)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!evidenceEntry) continue;
    const suggestion = { ...parsed.data, contextId: evidenceEntry.id, contextTimestamp: evidenceEntry.timestamp };
    const previous = suggestions.get(call.id);
    if (!previous || suggestion.confidence > previous.confidence) suggestions.set(call.id, suggestion);
  }
  return [...suggestions.values()];
}

type SchedulerOptions = {
  store: CallStore;
  context: ContextBuffer;
  provider: JudgeProvider;
  isEnabled: () => boolean;
  publish: (suggestions: JudgeSuggestion[], newlyCreated: JudgeSuggestion[]) => void;
};

export class JudgeScheduler {
  private lastContextId = 0;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly suggestions = new Map<number, JudgeSuggestion>();

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch((error: Error) => console.error(`Judge check failed: ${error.message}`)); }, INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getSuggestions(): JudgeSuggestion[] {
    const openIds = new Set(this.options.store.listOpenCalls().map((call) => call.id));
    for (const id of this.suggestions.keys()) if (!openIds.has(id)) this.suggestions.delete(id);
    return [...this.suggestions.values()];
  }

  async runOnce(now = Date.now()): Promise<JudgeSuggestion[]> {
    if (this.running || !this.options.isEnabled()) return [];
    this.running = true;
    try {
      const calls = this.options.store.listOpenCalls().map((call) => ({ id: call.id, text: call.text, createdAt: call.created_at, viewerId: call.viewer_id }));
      if (!calls.length) return [];
      const recent = this.options.context.recent(now).filter((entry) => entry.timestamp <= now);
      const newEntries = recent.filter((entry) => entry.id > this.lastContextId);
      if (!newEntries.length) return [];
      const eligibleCalls = calls.filter((call) => newEntries.some((entry) => entry.timestamp > call.createdAt));
      if (!eligibleCalls.length) {
        this.lastContextId = Math.max(...newEntries.map((entry) => entry.id));
        return [];
      }
      const burstEntries = eligibleCalls.flatMap((call) => buildChatReactionBursts(call, recent));
      const usableContext = [...recent.filter((entry) => eligibleCalls.some((call) => entry.timestamp > call.createdAt)), ...burstEntries];
      const result = await this.options.provider.evaluate({
        calls: eligibleCalls,
        context: usableContext.map((entry) => ({
          t: entry.timestamp,
          source: entry.source,
          text: entry.text,
          ...(entry.callId !== undefined ? { callId: entry.callId } : {}),
          ...(entry.chatters !== undefined ? { chatters: entry.chatters } : {}),
          ...(entry.chatterId !== undefined ? { chatterId: entry.chatterId } : {}),
          ...(entry.bot !== undefined ? { bot: entry.bot } : {}),
        })),
      });
      const suggestions = validateSuggestions(result, eligibleCalls, usableContext);
      this.lastContextId = Math.max(...newEntries.map((entry) => entry.id));
      for (const suggestion of suggestions) this.suggestions.set(suggestion.callId, suggestion);
      const current = this.getSuggestions();
      if (suggestions.length) this.options.publish(current, suggestions);
      return suggestions;
    } finally {
      this.running = false;
    }
  }
}
