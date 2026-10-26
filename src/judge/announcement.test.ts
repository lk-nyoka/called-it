import { describe, expect, it, vi } from "vitest";
import { createJudgeAnnouncementPublisher } from "./announcement.js";

describe("judge chat announcements", () => {
  it("announces new evidence once and broadcasts suggestions", () => {
    const broadcast = vi.fn();
    const send = vi.fn(async (_message: string) => {});
    const enqueue = vi.fn();
    const publish = createJudgeAnnouncementPublisher(broadcast, send, enqueue);
    const suggestion = { callId: 12, confidence: 0.8, evidence: "Mira found the golden key.", contextId: 41, contextTimestamp: 100 };
    publish([suggestion], [suggestion]);
    publish([suggestion], []);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(suggestion);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("🔎 Judge spotted evidence for Call #12: 'Mira found the golden key.'. Reply !receipts or !cap when the jury opens.");
  });

  it("keeps chat announcements short", () => {
    const send = vi.fn(async (_message: string) => {});
    createJudgeAnnouncementPublisher(() => {}, send)([
      { callId: 1, confidence: 0.9, evidence: "a".repeat(500), contextId: 4, contextTimestamp: 100 },
    ]);
    expect(send.mock.calls[0][0].length).toBeLessThan(500);
    expect(send.mock.calls[0][0]).toContain("…");
  });
});
