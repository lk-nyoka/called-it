import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatCommandHandler, type ChatMessageEvent } from "./commands.js";
import { containsBlockedWord } from "./filter.js";
import { CallStore } from "../core/callStore.js";
import { JuryManager } from "../core/jury.js";
import { resolveCallAndBroadcast } from "./commands.js";

describe("chat commands", () => {
  let store: CallStore;
  let handler: ReturnType<typeof createChatCommandHandler>;
  let sent: string[];
  afterEach(() => { handler?.stop(); store?.close(); });

  function setup() {
    store = new CallStore(":memory:");
    sent = [];
    handler = createChatCommandHandler(store, async (message) => { sent.push(message); }, { expiryTimer: false });
  }

  function event(text: string, overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
    return {
      message: { text },
      chatter_user_id: "viewer-1",
      chatter_user_login: "viewer",
      broadcaster_user_id: "broadcaster-1",
      badges: [],
      ...overrides,
    };
  }

  it("accepts valid calls, rejects length and blocked-language violations", async () => {
    setup();
    await handler.handleChatMessage(event("!call 3 phases before the boss"));
    expect(sent[0]).toMatch(/^📌 Call #1 locked in$/);
    await handler.handleChatMessage(event("!call nope"));
    await handler.handleChatMessage(event(`!call ${"a".repeat(121)}`, { chatter_user_id: "viewer-2", chatter_user_login: "viewer2" }));
    await handler.handleChatMessage(event("!call this is f.u.c.k bad"));
    expect(sent[1]).toContain("5–120");
    expect(sent[2]).toContain("5–120");
    expect(sent[3]).toContain("blocked language");
    expect(store.listOpenCalls()).toHaveLength(1);
  });

  it("shows a viewer's calls and the top five leaderboard", async () => {
    setup();
    await handler.handleChatMessage(event("!call boss drops a key"));
    await handler.handleChatMessage(event("!mycalls"));
    expect(sent.at(-1)).toContain("#1 OPEN: boss drops a key");
    await handler.handleChatMessage(event("!prophets"));
    expect(sent.at(-1)).toBe("No prophets yet. Be the first to call it!");
  });

  it("keeps !calledit as help and routes !receipts and !cap to jury voting", async () => {
    setup();
    await handler.handleChatMessage(event("!calledit"));
    await handler.handleChatMessage(event("!receipts"));
    await handler.handleChatMessage(event("!cap"));
    expect(sent).toEqual([
      expect.stringContaining("Vote during a jury with !receipts or !cap"),
      "There is no jury open right now.",
      "There is no jury open right now.",
    ]);
  });

  it("explains extra arguments on commands that take none", async () => {
    setup();
    await handler.handleChatMessage(event("!mycalls please"));
    await handler.handleChatMessage(event("!prophets please"));
    expect(sent).toEqual(["Usage: !mycalls", "Usage: !prophets"]);
  });

  it("replies with the open call number when the same viewer tries again", async () => {
    setup();
    await handler.handleChatMessage(event("!call chat goes quiet for a full minute"));
    await handler.handleChatMessage(event("!call the next chest is a mimic"));
    expect(sent[1]).toBe("@viewer you already have an open call (#1). Wait for it to resolve!");
  });

  it("stores the configured provider's boldness score when a call is created", async () => {
    setup();
    handler.stop();
    handler = createChatCommandHandler(store, async (message) => { sent.push(message); }, {
      expiryTimer: false,
      scoreBoldness: async () => 4,
    });
    await handler.handleChatMessage(event("!call the final boss drops the key"));
    expect(store.getCall(1)?.boldness).toBe(4);
  });

  it("shows usage for missing or malformed moderator command arguments", async () => {
    setup();
    const mod = event("", { chatter_user_id: "mod-1", chatter_user_login: "mod", badges: [{ set_id: "moderator" }] });
    for (const command of ["!yes", "!no", "!nuke", "!yes nope", "!judge maybe"]) {
      await handler.handleChatMessage({ ...mod, message: { text: command } });
    }
    expect(sent).toEqual([
      "Usage: !yes <call id>",
      "Usage: !no <call id>",
      "Usage: !nuke <call id>",
      "Usage: !yes <call id>",
      "Usage: !judge on or !judge off",
    ]);
  });

  it("lets the broadcaster confirm their own call and reports unavailable calls", async () => {
    setup();
    const broadcasterLogin = process.env.BROADCASTER_LOGIN;
    process.env.BROADCASTER_LOGIN = "owner";
    try {
      const broadcaster = event("!call my own prediction comes true", {
        chatter_user_id: "owner-id",
        chatter_user_login: "owner",
        broadcaster_user_id: undefined,
      });
      await handler.handleChatMessage(broadcaster);
      await handler.handleChatMessage({ ...broadcaster, message: { text: "!yes 1" } });
      expect(store.getCall(1)?.status).toBe("correct");
      expect(sent.at(-1)).toContain("Call #1 confirmed");
      await handler.handleChatMessage({ ...broadcaster, message: { text: "!no 999" } });
      expect(sent.at(-1)).toBe("Call #999 was not found.");
    } finally {
      if (broadcasterLogin === undefined) delete process.env.BROADCASTER_LOGIN;
      else process.env.BROADCASTER_LOGIN = broadcasterLogin;
    }
  });

  it("explains to regular viewers why mod commands are unavailable", async () => {
    setup();
    await handler.handleChatMessage(event("!yes 2"));
    await handler.handleChatMessage(event("!judge off"));
    expect(sent).toEqual([
      "Only the broadcaster and moderators can use that command.",
      "Only the broadcaster and moderators can use !judge.",
    ]);
    expect(handler.isJudgeEnabled()).toBe(true);
  });

  it("returns a friendly reply when storage throws", async () => {
    setup();
    vi.spyOn(store, "createCall").mockImplementation(() => { throw new Error("database unavailable"); });
    await handler.handleChatMessage(event("!call a valid prediction"));
    expect(sent).toEqual(["Sorry, that command hit a snag. Please try again."]);
  });

  it("restricts resolution, nuke and judge toggles to mods and broadcaster", async () => {
    setup();
    const mod = event("", { chatter_user_id: "mod-1", chatter_user_login: "mod", badges: [{ set_id: "moderator" }] });
    await handler.handleChatMessage(event("!call viewer makes a call"));
    await handler.handleChatMessage(event("!call viewer makes another call", { chatter_user_id: "viewer-2", chatter_user_login: "viewer2" }));
    await handler.handleChatMessage(event("!call viewer makes third call", { chatter_user_id: "viewer-3", chatter_user_login: "viewer3" }));
    await handler.handleChatMessage(event("!yes 1"));
    await handler.handleChatMessage(event("!no 2"));
    await handler.handleChatMessage(event("!nuke 3"));
    await handler.handleChatMessage(event("!judge off"));
    expect(store.getCall(1)?.status).toBe("open");
    expect(store.getCall(2)?.status).toBe("open");
    expect(store.getCall(3)?.status).toBe("open");
    expect(handler.isJudgeEnabled()).toBe(true);

    await handler.handleChatMessage({ ...mod, message: { text: "!yes 1" } });
    expect(store.getCall(1)?.status).toBe("correct");
    expect(store.getLeaderboard()[0]?.points).toBeGreaterThan(0);
    await handler.handleChatMessage({ ...mod, message: { text: "!no 2" } });
    await handler.handleChatMessage({ ...mod, message: { text: "!nuke 3" } });
    expect(store.getCall(2)?.status).toBe("incorrect");
    expect(store.getCall(3)?.status).toBe("nuked");

    await handler.handleChatMessage({ ...mod, message: { text: "!judge off" } });
    expect(handler.isJudgeEnabled()).toBe(false);
    const broadcaster = event("!judge on", { chatter_user_id: "broadcaster-1", chatter_user_login: "owner" });
    await handler.handleChatMessage(broadcaster);
    expect(handler.isJudgeEnabled()).toBe(true);
  });

  it("opens a jury only for a moderator and moderator overrides cancel it", async () => {
    store = new CallStore(":memory:");
    sent = [];
    store.createCall({ viewerId: "author", viewerLogin: "author", text: "the final boss drops a key" });
    const jury = new JuryManager(store, () => {}, async (message) => { sent.push(message); }, (id, result) => resolveCallAndBroadcast(store, id, result).ok, 60_000);
    handler = createChatCommandHandler(store, async (message) => { sent.push(message); }, { expiryTimer: false, jury });
    await handler.handleChatMessage(event("!jury 1"));
    expect(sent.at(-1)).toContain("Only the broadcaster and moderators");
    const mod = event("!jury 1", { chatter_user_id: "mod", chatter_user_login: "mod", badges: [{ set_id: "moderator" }] });
    await handler.handleChatMessage(mod);
    expect(jury.getState()?.callId).toBe(1);
    await handler.handleChatMessage({ ...mod, message: { text: "!yes 1" } });
    expect(store.getCall(1)?.status).toBe("correct");
    expect(jury.getState()).toBeUndefined();
  });

  it("reports jury command usage and active-jury conflicts", async () => {
    store = new CallStore(":memory:");
    sent = [];
    store.createCall({ viewerId: "author", viewerLogin: "author", text: "the final boss drops a key" });
    store.createCall({ viewerId: "author2", viewerLogin: "author2", text: "the next chest is a mimic" });
    const jury = new JuryManager(store, () => {}, async (message) => { sent.push(message); }, () => {}, 60_000);
    handler = createChatCommandHandler(store, async (message) => { sent.push(message); }, { expiryTimer: false, jury });
    const mod = event("!jury", { chatter_user_id: "mod", chatter_user_login: "mod", badges: [{ set_id: "moderator" }] });
    await handler.handleChatMessage(mod);
    await handler.handleChatMessage({ ...mod, message: { text: "!jury 1" } });
    await handler.handleChatMessage({ ...mod, message: { text: "!jury 2" } });
    expect(sent).toContain("Usage: !jury <call id>");
    expect(sent).toContain("A jury is already open. Let it finish first.");
  });

  it("keeps !no and !nuke as moderator overrides during a jury", async () => {
    store = new CallStore(":memory:");
    sent = [];
    store.createCall({ viewerId: "author1", viewerLogin: "author1", text: "the final boss drops a key" });
    store.createCall({ viewerId: "author2", viewerLogin: "author2", text: "the next chest is a mimic" });
    const jury = new JuryManager(store, () => {}, async () => {}, (id, result) => resolveCallAndBroadcast(store, id, result).ok, 60_000);
    handler = createChatCommandHandler(store, async (message) => { sent.push(message); }, { expiryTimer: false, jury });
    const mod = event("", { chatter_user_id: "mod", chatter_user_login: "mod", badges: [{ set_id: "moderator" }] });
    await handler.handleChatMessage({ ...mod, message: { text: "!jury 1" } });
    await handler.handleChatMessage({ ...mod, message: { text: "!no 1" } });
    expect(store.getCall(1)?.status).toBe("incorrect");
    expect(jury.getState()).toBeUndefined();
    await handler.handleChatMessage({ ...mod, message: { text: "!jury 2" } });
    await handler.handleChatMessage({ ...mod, message: { text: "!nuke 2" } });
    expect(store.getCall(2)?.status).toBe("nuked");
    expect(jury.getState()).toBeUndefined();
  });

  it("filters basic profanity despite punctuation separators", () => {
    expect(containsBlockedWord("that is f.u.c.k.ed")).toBe(true);
    expect(containsBlockedWord("a prediction about a boss fight")).toBe(false);
  });
});
