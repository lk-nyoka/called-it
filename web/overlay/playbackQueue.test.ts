import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackQueue } from "./playbackQueue.js";

describe("overlay playback queue", () => {
  afterEach(() => vi.useRealTimers());

  it("holds CALLED IT for five seconds before starting the next jury", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const queue = createPlaybackQueue((event) => { if (event) shown.push(event.type); });

    queue.enqueue({ type: "called-it", callId: 1 });
    queue.enqueue({ type: "jury:start", callId: 2 });
    expect(shown).toEqual(["called-it"]);

    vi.advanceTimersByTime(4_999);
    expect(shown).toEqual(["called-it"]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["called-it", "jury:start"]);
  });

  it("holds Hall of Cap for three seconds, then advances", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const queue = createPlaybackQueue((event) => { if (event) shown.push(event.type); });
    queue.enqueue({ type: "hall-of-cap", callId: 1 });
    queue.enqueue({ type: "jury:start", callId: 2 });
    vi.advanceTimersByTime(2_999);
    expect(shown).toEqual(["hall-of-cap"]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["hall-of-cap", "jury:start"]);
  });
});
