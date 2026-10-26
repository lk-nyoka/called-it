import { describe, expect, it } from "vitest";
import { KeywordJudge } from "./keyword.js";

const judge = new KeywordJudge();

describe("KeywordJudge", () => {
  it("flags a clearly supported prediction with an exact evidence quote", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 4, text: "Mira finds the golden key", createdAt: 1_000 }],
      context: [{ t: 1_100, source: "speech", text: "Mira finds the golden key in the vault." }],
    });
    expect(result.candidates).toEqual([{ callId: 4, confidence: 0.95, evidence: "Mira finds the golden key in the vault." }]);
  });

  it("does not flag clearly unrelated evidence", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 5, text: "Mira finds the golden key", createdAt: 1_000 }],
      context: [{ t: 1_100, source: "speech", text: "Mira found a bronze coin in the vault." }],
    });
    expect(result.candidates).toEqual([]);
  });

  it("lowers confidence when matched evidence is negated", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 10, text: "Mira finds the golden key", createdAt: 1_000 }],
      context: [{ t: 1_100, source: "speech", text: "Mira does not find the golden key." }],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.confidence).toBeCloseTo(0.7);
    expect(result.candidates[0]?.confidence).toBeLessThanOrEqual(0.7);
  });

  it.each([
    "Mira does not find the golden key.",
    "Mira didn’t find the golden key.",
    "Mira never finds the golden key.",
    "Mira has no golden key and did not find one.",
    "Mira failed to find the golden key.",
    "Mira missed the golden key.",
  ])("lowers confidence for simple negation: %s", async (text) => {
    const result = await judge.evaluate({
      calls: [{ id: 10, text: "Mira finds the golden key", createdAt: 1_000 }],
      context: [{ t: 1_100, source: "speech", text }],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.confidence).toBeLessThanOrEqual(0.7);
  });

  it("flags a partly supported prediction at the candidate threshold", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 6, text: "Mira finds the golden key before the timer ends", createdAt: 1_000 }],
      context: [{ t: 1_100, source: "speech", text: "Mira finds the golden key." }],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.candidates[0]?.evidence).toBe("Mira finds the golden key.");
  });

  it("rejects evidence from before the call was made", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 7, text: "Mira finds the golden key", createdAt: 1_100 }],
      context: [{ t: 1_000, source: "speech", text: "Mira finds the golden key." }],
    });
    expect(result.candidates).toEqual([]);
  });

  it("honors simple next-five-minutes deadlines", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 8, text: "Mira finds the golden key in the next 5 minutes", createdAt: 1_000 }],
      context: [{ t: 1_000 + 5 * 60_000 + 1, source: "event", text: "Mira finds the golden key." }],
    });
    expect(result.candidates).toEqual([]);
  });

  it("treats an aggregate human chat burst as strong evidence but a single chat message as weak", async () => {
    const result = await judge.evaluate({
      calls: [{ id: 11, text: "the boss dies", createdAt: 1_000, viewerId: "author" }],
      context: [
        { t: 1_100, source: "chat", text: "the boss died", chatterId: "one-viewer" },
        { t: 1_200, source: "chat", text: "the boss died", chatterId: "author", chatters: 8, callId: 11 },
        { t: 1_300, source: "chat", text: "8 chatters: “the boss died”", chatters: 8, callId: 11 },
      ],
    });
    expect(result.candidates).toEqual([{ callId: 11, confidence: 0.95, evidence: "8 chatters: “the boss died”" }]);
  });
});
