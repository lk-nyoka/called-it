import { describe, expect, it } from "vitest";
import type { ContextEntry } from "../core/context.js";
import { buildChatReactionBursts, getChatBurstConfig } from "./chatReactions.js";

const call = { id: 12, text: "the boss dies", createdAt: 1_000, viewerId: "call-author" };

function messages(rows: Array<{ user: string; text: string; t?: number }>): ContextEntry[] {
  return rows.map((row, index) => ({
    id: index + 1,
    timestamp: row.t ?? 1_100 + index * 250,
    source: "chat",
    text: row.text,
    chatterId: row.user,
    chatterLogin: row.user,
  }));
}

describe("chat reaction bursts", () => {
  it("defaults to three chatters within five seconds and reads environment overrides", () => {
    expect(getChatBurstConfig({})).toEqual({ minimumChatters: 3, windowMs: 5_000 });
    expect(getChatBurstConfig({ CHAT_BURST_MIN: "2", CHAT_BURST_WINDOW_SECONDS: "7" })).toEqual({ minimumChatters: 2, windowMs: 7_000 });
    expect(getChatBurstConfig({ CHAT_BURST_MIN: "invalid", CHAT_BURST_WINDOW_SECONDS: "0" })).toEqual({ minimumChatters: 3, windowMs: 5_000 });
  });

  it("does not count one person spamming the same reaction", () => {
    const context = messages(Array.from({ length: 12 }, () => ({ user: "one-viewer", text: "the boss died" })));
    expect(buildChatReactionBursts(call, context)).toEqual([]);
  });

  it("never uses messages from the call author as corroboration", () => {
    const context = messages(Array.from({ length: 8 }, () => ({ user: "call-author", text: "the boss died" })));
    expect(buildChatReactionBursts(call, context)).toEqual([]);
  });

  it("counts distinct chatters reacting in a short burst and formats evidence for the judge", () => {
    const context = messages([
      { user: "viewer-1", text: "the boss died" },
      { user: "viewer-2", text: "he died" },
      { user: "viewer-3", text: "NOOO" },
      { user: "viewer-4", text: "no way he did it" },
      { user: "viewer-5", text: "the boss died" },
      { user: "viewer-6", text: "he died" },
      { user: "viewer-7", text: "NOOO" },
      { user: "viewer-8", text: "the boss died" },
    ]);
    const bursts = buildChatReactionBursts(call, context);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ source: "chat", callId: 12, chatters: 8, text: "8 chatters: “the boss died”" });
  });

  it("allows a two-person live test when CHAT_BURST_MIN is set to two", () => {
    const context = messages([
      { user: "helper-1", text: "the boss died", t: 1_100 },
      { user: "helper-2", text: "he died", t: 5_900 },
    ]);
    const config = getChatBurstConfig({ CHAT_BURST_MIN: "2", CHAT_BURST_WINDOW_SECONDS: "5" });
    const bursts = buildChatReactionBursts(call, context, config);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ chatters: 2, text: "2 chatters: “the boss died”" });
  });

  it("uses the configured time window", () => {
    const context = messages([
      { user: "helper-1", text: "the boss died", t: 1_100 },
      { user: "helper-2", text: "he died", t: 4_100 },
    ]);
    expect(buildChatReactionBursts(call, context, { minimumChatters: 2, windowMs: 2_000 })).toEqual([]);
  });
});
