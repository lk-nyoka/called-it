import { afterEach, describe, expect, it, vi } from "vitest";
import { CallStore } from "./callStore.js";
import { JuryManager } from "./jury.js";

describe("jury voting", () => {
  let store: CallStore;
  let jury: JuryManager;
  let events: unknown[];
  let messages: string[];
  let resolutions: Array<[number, "correct" | "incorrect"]>;

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    store = new CallStore(":memory:");
    store.createCall({ viewerId: "author-id", viewerLogin: "author", text: "the boss drops the key" });
    events = [];
    messages = [];
    resolutions = [];
    jury = new JuryManager(store, (event) => events.push(event), async (message) => { messages.push(message); }, (id, result) => {
      resolutions.push([id, result]);
      return store.resolveCall(id, result).ok;
    }, 10_000);
  }

  afterEach(() => { vi.useRealTimers(); store?.close(); });

  it("opens a 10-second jury and broadcasts its start", async () => {
    setup();
    expect(await jury.open(1)).toEqual({ ok: true });
    expect(jury.getState()).toMatchObject({ callId: 1, durationMs: 10_000, receipts: 0, cap: 0 });
    expect(events[0]).toEqual({ type: "jury:start", callId: 1, viewerLogin: "author", callText: "the boss drops the key", durationMs: 10_000, receipts: 0, cap: 0 });
    expect(messages[0]).toContain("!receipts or !cap");
  });

  it("blocks the author, counts each viewer once, and stays quiet for accepted votes", async () => {
    setup();
    await jury.open(1);
    expect(await jury.vote("author-id", "author", "receipts")).toBe("You can’t vote on your own call.");
    expect(await jury.vote("author-id", "author", "cap")).toBeUndefined();
    expect(await jury.vote("voter", "voter", "receipts")).toBeUndefined();
    expect(await jury.vote("voter", "voter", "cap")).toBeUndefined();
    expect(jury.getState()).toMatchObject({ receipts: 1, cap: 0 });
  });

  it("replies once per viewer when no jury is open", async () => {
    setup();
    expect(await jury.vote("voter", "voter", "receipts")).toBe("There is no jury open right now.");
    expect(await jury.vote("voter", "voter", "cap")).toBeUndefined();
    await jury.open(1);
    await jury.vote("voter", "voter", "receipts");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await jury.vote("voter", "voter", "cap")).toBe("There is no jury open right now.");
  });

  it("resolves a receipts majority and awards points through the resolver", async () => {
    setup();
    await jury.open(1);
    await jury.vote("v1", "v1", "receipts");
    await jury.vote("v2", "v2", "receipts");
    await jury.vote("v3", "v3", "cap");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([[1, "correct"]]);
    expect(store.getCall(1)?.status).toBe("correct");
    expect(store.getLeaderboard()[0]?.points).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "jury:end", callId: 1 });
  });

  it("marks a cap majority incorrect", async () => {
    setup();
    await jury.open(1);
    await jury.vote("v1", "v1", "cap");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([[1, "incorrect"]]);
    expect(store.getCall(1)?.status).toBe("incorrect");
    expect(jury.enqueue(1, 0.9)).toBe(false);
  });

  it("leaves ties and empty juries unresolved", async () => {
    setup();
    await jury.open(1);
    await jury.vote("v1", "v1", "receipts");
    await jury.vote("v2", "v2", "cap");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([]);
    expect(store.getCall(1)?.status).toBe("open");
    expect(messages.at(-1)).toContain("unresolved");
    expect(messages.at(-1)).toContain("jury tied");

    await jury.open(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([]);
    expect(messages.at(-1)).toContain("no votes and judge confidence was below 85%");
  });

  it("uses high judge confidence only when the jury has no votes", async () => {
    setup();
    await jury.open(1, 0.85);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([[1, "correct"]]);

    store.createCall({ viewerId: "author-2", viewerLogin: "author2", text: "the next chest is a mimic" });
    await jury.open(2, 0.84);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([[1, "correct"]]);
    expect(store.getCall(2)?.status).toBe("open");
  });

  it("does not confirm on one RECEIPTS vote because the minimum vote threshold is two", async () => {
    setup();
    await jury.open(1, 0.99);
    await jury.vote("voter", "voter", "receipts");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolutions).toEqual([]);
    expect(store.getCall(1)?.status).toBe("open");
    expect(messages.at(-1)).toContain("at least two votes and 60% RECEIPTS");
  });

  it("queues flagged calls in order and cools down a call after its jury closes", async () => {
    setup();
    store.createCall({ viewerId: "author-2", viewerLogin: "author2", text: "the next chest is a mimic" });
    expect(jury.enqueue(1, 0.7)).toBe(true);
    expect(jury.enqueue(2, 0.8)).toBe(true);
    expect(jury.enqueue(1, 0.9)).toBe(false);
    expect(jury.getState()?.callId).toBe(1);
    await jury.vote("v1", "v1", "cap");
    await jury.vote("v2", "v2", "receipts");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getCall(1)?.status).toBe("open");
    expect(jury.enqueue(1, 0.9)).toBe(false);
    expect(jury.getState()?.callId).toBe(2);
    expect(messages).toContain("Jury is open for Call #2! Vote !receipts or !cap for 10 seconds.");
  });
});
