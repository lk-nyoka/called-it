import { afterEach, describe, expect, it, vi } from "vitest";
import { CallStore } from "../core/callStore.js";
import { ContextBuffer, type ContextEntry } from "../core/context.js";
import { JudgeScheduler, validateSuggestions } from "./scheduler.js";

const calls = [{ id: 9, text: "Mira finds the golden key", createdAt: 2_000 }];
const oldEvidence: ContextEntry = { id: 1, timestamp: 1_999, source: "speech", text: "Mira finds the golden key." };

describe("judge suggestion validation", () => {
  it("rejects an otherwise convincing quote if it predates the call", () => {
    expect(validateSuggestions({ candidates: [{ callId: 9, confidence: 0.99, evidence: oldEvidence.text }] }, calls, [oldEvidence])).toEqual([]);
  });

  it("requires evidence to exactly match a recent context line and drops invalid candidates", () => {
    const fresh: ContextEntry = { id: 2, timestamp: 2_001, source: "speech", text: "Mira finds the golden key." };
    expect(validateSuggestions({ candidates: [
      { callId: 9, confidence: 0.8, evidence: "Mira finds it" },
      { callId: 999, confidence: 0.8, evidence: fresh.text },
      { callId: 9, confidence: 0.5, evidence: fresh.text },
      { callId: 9, confidence: 0.8, evidence: fresh.text, extra: "invalid" },
    ] }, calls, [fresh])).toEqual([]);

    expect(validateSuggestions({ candidates: [{ callId: 9, confidence: 0.8, evidence: fresh.text }] }, calls, [fresh])).toEqual([
      { callId: 9, confidence: 0.8, evidence: fresh.text, contextId: 2, contextTimestamp: 2_001 },
    ]);
  });
});

describe("JudgeScheduler", () => {
  let store: CallStore;
  afterEach(() => store?.close());

  it("evaluates fresh context once and publishes an evidence-backed suggestion", async () => {
    store = new CallStore(":memory:");
    const now = Date.now() - 1_000;
    const call = store.createCall({ viewerId: "viewer-1", viewerLogin: "mira", text: "Mira finds the golden key", now });
    if (!call.ok) throw new Error("call was not created");
    const context = new ContextBuffer();
    context.add("speech", "Mira finds the golden key.", now + 100, now + 200);
    const provider = { evaluate: vi.fn(async () => ({ candidates: [{ callId: call.call.id, confidence: 0.8, evidence: "Mira finds the golden key." }] })), scoreBoldness: async () => 2 };
    const publish = vi.fn();
    const scheduler = new JudgeScheduler({ store, context, provider, isEnabled: () => true, publish });

    const first = await scheduler.runOnce(now + 200);
    const second = await scheduler.runOnce(now + 300);
    expect(first).toEqual([{ callId: call.call.id, confidence: 0.8, evidence: "Mira finds the golden key.", contextId: 1, contextTimestamp: now + 100 }]);
    expect(second).toEqual([]);
    expect(provider.evaluate).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not send pre-call context to a provider", async () => {
    store = new CallStore(":memory:");
    const now = Date.now() - 1_000;
    store.createCall({ viewerId: "viewer-1", viewerLogin: "mira", text: "Mira finds the golden key", now: now + 100 });
    const context = new ContextBuffer();
    context.add("speech", "Mira finds the golden key.", now + 50, now + 200);
    const provider = { evaluate: vi.fn(async () => ({ candidates: [] })), scoreBoldness: async () => 2 };
    const scheduler = new JudgeScheduler({ store, context, provider, isEnabled: () => true, publish: () => undefined });

    expect(await scheduler.runOnce(now + 200)).toEqual([]);
    expect(provider.evaluate).not.toHaveBeenCalled();
  });

  it("adds call-author-filtered chat bursts to the judge context", async () => {
    store = new CallStore(":memory:");
    const now = Date.now() - 1_000;
    const call = store.createCall({ viewerId: "author-id", viewerLogin: "author", text: "the boss dies", now });
    if (!call.ok) throw new Error("call was not created");
    const context = new ContextBuffer();
    for (let index = 0; index < 8; index++) {
      context.add("chat", "the boss died", now + 100 + index * 200, now + 2_000, {
        chatterId: index === 0 ? "author-id" : `viewer-${index}`,
      });
    }
    let evaluatedContext: Array<{ text: string; chatters?: number }> = [];
    const provider = {
      evaluate: vi.fn(async (input) => {
        evaluatedContext = input.context;
        return { candidates: [{ callId: call.call.id, confidence: 0.9, evidence: "7 chatters: “the boss died”" }] };
      }),
      scoreBoldness: async () => 2,
    };
    const scheduler = new JudgeScheduler({ store, context, provider, isEnabled: () => true, publish: () => undefined });
    const suggestions = await scheduler.runOnce(now + 2_000);
    expect(evaluatedContext).toContainEqual({ t: now + 1_500, source: "chat", text: "7 chatters: “the boss died”", callId: call.call.id, chatters: 7 });
    expect(suggestions).toEqual([expect.objectContaining({ callId: call.call.id, evidence: "7 chatters: “the boss died”" })]);
  });
});
