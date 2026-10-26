import type { CallStore } from "./callStore.js";

export type JuryState = { callId: number; viewerLogin: string; callText: string; confidence: number; endsAt: number; durationMs: number; receipts: number; cap: number };
type QueuedJury = { callId: number; confidence: number; announceWhenOpened: boolean };
type JuryEvent =
  | { type: "jury:start"; callId: number; viewerLogin: string; callText: string; durationMs: number; receipts: number; cap: number }
  | { type: "jury:update"; callId: number; receipts: number; cap: number }
  | { type: "jury:end"; callId: number };

export class JuryManager {
  private active?: JuryState;
  private timer?: ReturnType<typeof setTimeout>;
  private queueResumeTimer?: ReturnType<typeof setTimeout>;
  private readonly votes = new Map<string, "receipts" | "cap">();
  private readonly rejectedVoteReplies = new Set<string>();
  private readonly queue: QueuedJury[] = [];
  private readonly cooldownUntil = new Map<number, number>();

  constructor(
    private readonly store: CallStore,
    private readonly publish: (event: JuryEvent) => void,
    private readonly send: (message: string) => Promise<void>,
    private readonly resolve: (id: number, result: "correct" | "incorrect") => boolean | string | void,
    private readonly durationMs = 10_000,
  ) {}

  getState(): JuryState | undefined { return this.active ? { ...this.active } : undefined; }

  async open(callId: number, confidence?: number): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_open" | "jury_active" }> {
    return this.openInternal(callId, confidence, true);
  }

  private async openInternal(callId: number, confidence: number | undefined, announce: boolean): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_open" | "jury_active" }> {
    if (this.active) return { ok: false, reason: "jury_active" };
    const queuedIndex = this.queue.findIndex((item) => item.callId === callId);
    const queued = queuedIndex >= 0 ? this.queue.splice(queuedIndex, 1)[0] : undefined;
    const judgeConfidence = confidence ?? queued?.confidence ?? 0;
    const call = this.store.getCall(callId);
    if (!call) return { ok: false, reason: "not_found" };
    if (call.status !== "open") return { ok: false, reason: "not_open" };
    this.votes.clear();
    this.rejectedVoteReplies.clear();
    this.active = { callId, viewerLogin: call.viewer_login, callText: call.text, confidence: judgeConfidence, endsAt: Date.now() + this.durationMs, durationMs: this.durationMs, receipts: 0, cap: 0 };
    this.publish({ type: "jury:start", callId, viewerLogin: call.viewer_login, callText: call.text, durationMs: this.durationMs, receipts: 0, cap: 0 });
    this.timer = setTimeout(() => { void this.closeByVote(); }, this.durationMs);
    this.timer.unref?.();
    if (announce) {
      try { await this.send(`Jury is open for Call #${callId}! Vote !receipts or !cap for 10 seconds.`); } catch { /* Keep the local jury timer running if Twitch chat is unavailable. */ }
    }
    return { ok: true };
  }

  enqueue(callId: number, confidence: number): boolean {
    if (!Number.isFinite(confidence) || confidence < 0.6 || confidence > 1) return false;
    if (this.active?.callId === callId || this.queue.some((item) => item.callId === callId)) return false;
    if ((this.cooldownUntil.get(callId) ?? 0) > Date.now()) return false;
    this.queue.push({ callId, confidence, announceWhenOpened: Boolean(this.active) });
    void this.openNext();
    return true;
  }

  async vote(viewerId: string, _viewerLogin: string, vote: "receipts" | "cap"): Promise<string | undefined> {
    const jury = this.active;
    if (!jury) return this.rejectionReply(viewerId, "There is no jury open right now.");
    if (Date.now() >= jury.endsAt) { await this.closeByVote(); return this.rejectionReply(viewerId, "There is no jury open right now."); }
    const call = this.store.getCall(jury.callId);
    if (!call || call.status !== "open") { this.cancel(jury.callId); return this.rejectionReply(viewerId, "There is no jury open right now."); }
    if (call.viewer_id === viewerId) return this.rejectionReply(viewerId, "You can’t vote on your own call.");
    if (this.votes.has(viewerId)) return undefined;
    this.votes.set(viewerId, vote);
    jury.receipts = [...this.votes.values()].filter((item) => item === "receipts").length;
    jury.cap = this.votes.size - jury.receipts;
    this.publish({ type: "jury:update", callId: jury.callId, receipts: jury.receipts, cap: jury.cap });
    return undefined;
  }

  private rejectionReply(viewerId: string, message: string): string | undefined {
    if (this.rejectedVoteReplies.has(viewerId)) return undefined;
    this.rejectedVoteReplies.add(viewerId);
    return message;
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

  resumeQueue(delayMs = 0): void {
    if (this.queueResumeTimer) clearTimeout(this.queueResumeTimer);
    this.queueResumeTimer = undefined;
    if (delayMs > 0) {
      this.queueResumeTimer = setTimeout(() => {
        this.queueResumeTimer = undefined;
        void this.openNext();
      }, delayMs);
      this.queueResumeTimer.unref?.();
    } else void this.openNext();
  }

  private async openNext(): Promise<void> {
    if (this.active || this.queueResumeTimer) return;
    while (this.queue.length && !this.active) {
      const next = this.queue.shift()!;
      if ((this.cooldownUntil.get(next.callId) ?? 0) > Date.now()) continue;
      const result = await this.openInternal(next.callId, next.confidence, next.announceWhenOpened);
      if (result.ok) return;
    }
  }

  private async closeByVote(): Promise<void> {
    const jury = this.active;
    if (!jury) return;
    let momentDelayMs = 0;
    this.cancel(jury.callId, false);
    this.cooldownUntil.set(jury.callId, Date.now() + 60_000);
    const totalVotes = jury.receipts + jury.cap;
    if (jury.receipts > jury.cap && totalVotes >= 2 && jury.receipts / totalVotes >= 0.6) {
      const resolution = this.resolve(jury.callId, "correct");
      if (resolution === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        momentDelayMs = 5_000;
        const message = typeof resolution === "string" ? resolution : `RECEIPTS! Call #${jury.callId} is confirmed.`;
        try { await this.send(message); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else if (jury.cap > jury.receipts) {
      if (this.resolve(jury.callId, "incorrect") === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        momentDelayMs = 3_000;
        try { await this.send(`CAP! Call #${jury.callId} is marked incorrect.`); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else if (totalVotes === 0 && jury.confidence >= 0.85) {
      const resolution = this.resolve(jury.callId, "correct");
      if (resolution === false) {
        try { await this.send(`Call #${jury.callId} is unresolved because it is no longer open.`); } catch { /* Twitch chat may be unavailable. */ }
      } else {
        momentDelayMs = 5_000;
        const message = typeof resolution === "string" ? resolution : `No jury votes; judge confidence was ${(jury.confidence * 100).toFixed(0)}%. Call #${jury.callId} is confirmed.`;
        try { await this.send(message); } catch { /* Twitch chat may be unavailable. */ }
      }
    } else {
      const result = totalVotes === 0
        ? `Call #${jury.callId} is unresolved: no votes and judge confidence was below 85%.`
        : jury.receipts === jury.cap
          ? `Call #${jury.callId} is unresolved: the jury tied.`
          : `Call #${jury.callId} is unresolved: confirmation needs at least two votes and 60% RECEIPTS.`;
      try { await this.send(result); } catch { /* Twitch chat may be unavailable. */ }
    }
    this.resumeQueue(momentDelayMs);
  }
}
