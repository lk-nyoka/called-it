import type { CallStore } from "./callStore.js";

export type JuryState = { callId: number; viewerLogin: string; callText: string; confidence: number; endsAt: number; durationMs: number; receipts: number; cap: number };
type QueuedJury = { callId: number; confidence: number };
type JuryEvent =
  | { type: "jury:start"; callId: number; viewerLogin: string; callText: string; durationMs: number; receipts: number; cap: number }
  | { type: "jury:update"; callId: number; receipts: number; cap: number }
  | { type: "jury:end"; callId: number };

export class JuryManager {
  private active?: JuryState;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly votes = new Map<string, "receipts" | "cap">();
  private readonly queue: QueuedJury[] = [];
  private readonly cooldownUntil = new Map<number, number>();

  constructor(
    private readonly store: CallStore,
    private readonly publish: (event: JuryEvent) => void,
    private readonly send: (message: string) => Promise<void>,
    private readonly resolve: (id: number, result: "correct" | "incorrect") => boolean | void,
    private readonly durationMs = 10_000,
  ) {}

  getState(): JuryState | undefined { return this.active ? { ...this.active } : undefined; }

  async open(callId: number, confidence?: number): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_open" | "jury_active" }> {
    if (this.active) return { ok: false, reason: "jury_active" };
    const queuedIndex = this.queue.findIndex((item) => item.callId === callId);
    const queued = queuedIndex >= 0 ? this.queue.splice(queuedIndex, 1)[0] : undefined;
    const judgeConfidence = confidence ?? queued?.confidence ?? 0;
    const call = this.store.getCall(callId);
    if (!call) return { ok: false, reason: "not_found" };
    if (call.status !== "open") return { ok: false, reason: "not_open" };
    this.votes.clear();
    this.active = { callId, viewerLogin: call.viewer_login, callText: call.text, confidence: judgeConfidence, endsAt: Date.now() + this.durationMs, durationMs: this.durationMs, receipts: 0, cap: 0 };
    this.publish({ type: "jury:start", callId, viewerLogin: call.viewer_login, callText: call.text, durationMs: this.durationMs, receipts: 0, cap: 0 });
    this.timer = setTimeout(() => { void this.closeByVote(); }, this.durationMs);
    this.timer.unref?.();
    try { await this.send(`Jury is open for Call #${callId}! Vote !receipts or !cap for 10 seconds.`); } catch { /* Keep the local jury timer running if Twitch chat is unavailable. */ }
    return { ok: true };
  }

  enqueue(callId: number, confidence: number): boolean {
    if (!Number.isFinite(confidence) || confidence < 0.6 || confidence > 1) return false;
    if (this.active?.callId === callId || this.queue.some((item) => item.callId === callId)) return false;
    if ((this.cooldownUntil.get(callId) ?? 0) > Date.now()) return false;
    this.queue.push({ callId, confidence });
    void this.openNext();
    return true;
  }

  async vote(viewerId: string, viewerLogin: string, vote: "receipts" | "cap"): Promise<string> {
    const jury = this.active;
    if (!jury) return "There is no jury open right now.";
    if (Date.now() >= jury.endsAt) { await this.closeByVote(); return "That jury has closed."; }
    const call = this.store.getCall(jury.callId);
    if (!call || call.status !== "open") { this.cancel(jury.callId); return "That jury has closed because its call is no longer open."; }
    if (call.viewer_id === viewerId) return "You can’t vote on your own call.";
    if (this.votes.has(viewerId)) return "You already voted on this jury.";
    this.votes.set(viewerId, vote);
    jury.receipts = [...this.votes.values()].filter((item) => item === "receipts").length;
    jury.cap = this.votes.size - jury.receipts;
    this.publish({ type: "jury:update", callId: jury.callId, receipts: jury.receipts, cap: jury.cap });
    return `Vote counted, @${viewerLogin}.`;
  }

  cancel(callId: number, resumeQueue = true): void {
    const queuedBefore = this.queue.length;
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index]?.callId === callId) this.queue.splice(index, 1);
    }
    if (this.active?.callId === callId) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.active = undefined;
      this.votes.clear();
      this.publish({ type: "jury:end", callId });
    }
    if (resumeQueue && (this.active === undefined || this.queue.length !== queuedBefore)) void this.openNext();
  }

  resumeQueue(): void { void this.openNext(); }

  private async openNext(): Promise<void> {
    if (this.active) return;
    while (this.queue.length && !this.active) {
      const next = this.queue.shift()!;
      if ((this.cooldownUntil.get(next.callId) ?? 0) > Date.now()) continue;
      const result = await this.open(next.callId, next.confidence);
      if (result.ok) return;
    }
  }

  private async closeByVote(): Promise<void> {
    const jury = this.active;
    if (!jury) return;
    this.cancel(jury.callId, false);
    this.cooldownUntil.set(jury.callId, Date.now() + 60_000);
    const totalVotes = jury.receipts + jury.cap;
    if (jury.receipts > jury.cap && totalVotes >= 2 && jury.receipts / totalVotes >= 0.6) {
      if (this.resolve(jury.callId, "correct") === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        try { await this.send(`RECEIPTS! Call #${jury.callId} is confirmed.`); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else if (jury.cap > jury.receipts) {
      if (this.resolve(jury.callId, "incorrect") === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        try { await this.send(`CAP! Call #${jury.callId} is marked incorrect.`); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else if (totalVotes === 0 && jury.confidence >= 0.85) {
      if (this.resolve(jury.callId, "correct") === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        try { await this.send(`No jury votes; judge confidence was ${(jury.confidence * 100).toFixed(0)}%. Call #${jury.callId} is confirmed.`); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else {
      const result = totalVotes === 0
        ? `Call #${jury.callId} is unresolved: no votes and judge confidence was below 85%.`
        : jury.receipts === jury.cap
          ? `Call #${jury.callId} is unresolved: the jury tied.`
          : `Call #${jury.callId} is unresolved: confirmation needs at least two votes and 60% RECEIPTS.`;
      try { await this.send(result); } catch { /* Twitch chat may be unavailable. */ }
    }
    void this.openNext();
  }
}
