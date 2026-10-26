import { describe, expect, it } from "vitest";
import { ContextBuffer } from "./context.js";
import { addChatEvidence } from "./chatEvidence.js";

describe("chat evidence ingestion", () => {
  it("stores ordinary human chat with chatter identity for later author filtering", () => {
    const context = new ContextBuffer();
    const entry = addChatEvidence(context, {
      message_type: "text",
      message: { text: "the boss died" },
      chatter_user_id: "viewer-1",
      chatter_user_login: "viewerone",
    }, "calleditbot", 1234);
    expect(entry).toMatchObject({ source: "chat", text: "the boss died", chatterId: "viewer-1", chatterLogin: "viewerone", timestamp: 1234 });
  });

  it("ignores commands, configured and known bots, and non-text notices", () => {
    const context = new ContextBuffer();
    const ordinary = { chatter_user_id: "viewer", chatter_user_login: "viewer" };
    expect(addChatEvidence(context, { ...ordinary, message: { text: "!receipts" } }, "calleditbot", 100)).toBeUndefined();
    expect(addChatEvidence(context, { ...ordinary, message: { text: "bot output" } }, "calleditbot", 101)).toBeDefined();
    expect(addChatEvidence(context, { ...ordinary, chatter_user_login: "nightbot", message: { text: "boss died" } }, "calleditbot", 102)).toBeUndefined();
    expect(addChatEvidence(context, { ...ordinary, chatter_user_login: "myhelper", message: { text: "boss died" } }, "calleditbot", 103)).toBeDefined();
    const configuredBots = process.env.CHAT_BOT_LOGINS;
    process.env.CHAT_BOT_LOGINS = "myhelper, anotherbot";
    try {
      expect(addChatEvidence(context, { ...ordinary, chatter_user_login: "myhelper", message: { text: "boss died" } }, "calleditbot", 104)).toBeUndefined();
    } finally {
      if (configuredBots === undefined) delete process.env.CHAT_BOT_LOGINS;
      else process.env.CHAT_BOT_LOGINS = configuredBots;
    }
    expect(addChatEvidence(context, { ...ordinary, message_type: "channel_points_highlighted", message: { text: "boss died" } }, "calleditbot", 105)).toBeUndefined();
    expect(context.recent(200)).toHaveLength(2);
  });
});
