export type ContextSource = "speech" | "event" | "chat";
export type ContextEntry = {
  id: number;
  timestamp: number;
  source: ContextSource;
  text: string;
  chatterId?: string;
  chatterLogin?: string;
  bot?: boolean;
  callId?: number;
  chatters?: number;
};

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

export class ContextBuffer {
  private entries: ContextEntry[] = [];
  private nextId = 1;

  add(source: ContextSource, text: string, timestamp = Date.now(), now = Date.now(), metadata: Partial<Pick<ContextEntry, "chatterId" | "chatterLogin" | "bot" | "callId" | "chatters">> = {}): ContextEntry {
    this.prune(now);
    const entry = { id: this.nextId++, timestamp, source, text, ...metadata };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    return entry;
  }

  recent(now = Date.now()): ContextEntry[] {
    this.prune(now);
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.nextId = 1;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((entry) => entry.timestamp >= now - WINDOW_MS && entry.timestamp <= now + 60_000);
  }
}

export const contextBuffer = new ContextBuffer();
