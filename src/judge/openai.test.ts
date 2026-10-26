import { afterEach, describe, expect, it, vi } from "vitest";
import { createJudgeProvider } from "./provider.js";
import { OpenAIJudge } from "./openai.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI judge", () => {
  it("requests strict structured output and drops schema-invalid candidates", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-6-luna");
      expect(body.text.format.strict).toBe(true);
      expect(body.store).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(body.text.format.schema.properties.candidates.type).toBe("array");
      const judgeInput = JSON.parse(body.input[1].content);
      expect(judgeInput.calls[0].context).toEqual([
        { t: 11, source: "speech", text: "new evidence" },
        { t: 13, source: "chat", text: "8 chatters: “the boss died”", chatters: 8 },
      ]);
      expect(body.input[0].content).toContain("pre-aggregated burst from at least three distinct non-author chatters");
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates: [
        { callId: 1, confidence: 0.8, evidence: "exact quote" },
        { callId: 2, confidence: 2, evidence: "out of range" },
      ] }) }] }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const judge = new OpenAIJudge("test-key");
    const result = await judge.evaluate({
      calls: [{ id: 1, text: "prediction", createdAt: 10, viewerId: "author" }],
      context: [
        { t: 9, source: "speech", text: "old evidence" },
        { t: 11, source: "speech", text: "new evidence" },
        { t: 12, source: "chat", text: "the boss died", chatterId: "author" },
        { t: 12, source: "chat", text: "the boss died", chatterId: "single-viewer" },
        { t: 13, source: "chat", text: "8 chatters: “the boss died”", chatters: 8, callId: 1 },
        { t: 14, source: "chat", text: "7 chatters: “another call evidence”", chatters: 7, callId: 2 },
      ],
    });
    expect(result).toEqual({ candidates: [{ callId: 1, confidence: 0.8, evidence: "exact quote" }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the keyword judge when OpenAI has no key or its request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unconfigured = createJudgeProvider("openai", "");
    expect(await unconfigured.scoreBoldness("a prediction with no API key")).toBe(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const fallback = createJudgeProvider("openai", "test-key");
    const result = await fallback.evaluate({
      calls: [{ id: 1, text: "Mira finds the golden key", createdAt: 10 }],
      context: [{ t: 11, source: "speech", text: "Mira finds the golden key." }],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.evidence).toBe("Mira finds the golden key.");
  });
});
