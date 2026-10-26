import { describe, expect, it } from "vitest";
import { ContextBuffer } from "./context.js";

describe("ContextBuffer", () => {
  it("keeps speech and events for five minutes and expires older entries", () => {
    const buffer = new ContextBuffer();
    const now = 10_000_000;
    buffer.add("speech", "The boss is here.", now - 299_999, now);
    buffer.add("event", "A raid arrived.", now - 300_001, now);

    expect(buffer.recent(now)).toEqual([
      { id: 1, timestamp: now - 299_999, source: "speech", text: "The boss is here." },
    ]);
  });

  it("rejects entries more than one minute in the future from the rolling window", () => {
    const buffer = new ContextBuffer();
    buffer.add("speech", "Future entry", 20_000, 10_000);
    buffer.add("speech", "Too far ahead", 70_001, 10_000);

    expect(buffer.recent(10_000).map((entry) => entry.text)).toEqual(["Future entry"]);
  });
});
