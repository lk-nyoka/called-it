import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type CallStatus = "open" | "correct" | "incorrect" | "nuked" | "expired";
export type CallRecord = {
  id: number;
  viewer_id: string;
  viewer_login: string;
  text: string;
  boldness: number;
  status: CallStatus;
  created_at: number;
  expires_at: number;
  points_awarded: number;
};

const EXPIRE_AFTER_MS = 30 * 60 * 1000;

export class CallStore {
  private readonly db: Database.Database;

  constructor(filename = path.resolve("data/calledit.db")) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        viewer_id TEXT NOT NULL,
        viewer_login TEXT NOT NULL,
        text TEXT NOT NULL,
        boldness INTEGER NOT NULL DEFAULT 2 CHECK (boldness BETWEEN 1 AND 5),
        status TEXT NOT NULL CHECK (status IN ('open', 'correct', 'incorrect', 'nuked', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        points_awarded INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_call_per_viewer
        ON calls(viewer_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS calls_open_expiry ON calls(status, expires_at);
      CREATE TABLE IF NOT EXISTS leaderboard (
        viewer_id TEXT PRIMARY KEY,
        viewer_login TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(calls)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "boldness")) {
      this.db.exec("ALTER TABLE calls ADD COLUMN boldness INTEGER NOT NULL DEFAULT 2 CHECK (boldness BETWEEN 1 AND 5)");
    }
  }

  close(): void {
    this.db.close();
  }

  expireCalls(now = Date.now()): number {
    return this.db.prepare("UPDATE calls SET status = 'expired', resolved_at = ? WHERE status = 'open' AND expires_at <= ?")
      .run(now, now).changes;
  }

  createCall(input: { viewerId: string; viewerLogin: string; text: string; boldness?: number; now?: number }):
    | { ok: true; call: CallRecord }
    | { ok: false; reason: "already_open" | "cap" } {
    const now = input.now ?? Date.now();
    const boldness = input.boldness ?? 2;
    if (!Number.isInteger(boldness) || boldness < 1 || boldness > 5) throw new RangeError("Call boldness must be an integer from 1 to 5.");
    return this.db.transaction(() => {
      this.expireCalls(now);
      const existing = this.db.prepare("SELECT 1 FROM calls WHERE viewer_id = ? AND status = 'open'").get(input.viewerId);
      if (existing) return { ok: false as const, reason: "already_open" as const };
      const openCount = (this.db.prepare("SELECT COUNT(*) AS count FROM calls WHERE status = 'open'").get() as { count: number }).count;
      if (openCount >= 30) return { ok: false as const, reason: "cap" as const };
      const result = this.db.prepare(`
        INSERT INTO calls (viewer_id, viewer_login, text, boldness, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)
      `).run(input.viewerId, input.viewerLogin, input.text, boldness, now, now + EXPIRE_AFTER_MS);
      const call = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(result.lastInsertRowid) as CallRecord;
      return { ok: true as const, call };
    })();
  }

  listViewerCalls(viewerId: string, limit = 20): CallRecord[] {
    this.expireCalls();
    return this.db.prepare("SELECT * FROM calls WHERE viewer_id = ? ORDER BY id DESC LIMIT ?").all(viewerId, limit) as CallRecord[];
  }

  listOpenCalls(): CallRecord[] {
    this.expireCalls();
    return this.db.prepare("SELECT * FROM calls WHERE status = 'open' ORDER BY id ASC").all() as CallRecord[];
  }

  getCall(id: number): CallRecord | undefined {
    this.expireCalls();
    return this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRecord | undefined;
  }

  getLeaderboard(limit = 5): Array<{ viewer_id: string; viewer_login: string; points: number }> {
    return this.db.prepare("SELECT viewer_id, viewer_login, points FROM leaderboard WHERE points > 0 ORDER BY points DESC, viewer_login COLLATE NOCASE ASC LIMIT ?")
      .all(limit) as Array<{ viewer_id: string; viewer_login: string; points: number }>;
  }

  hasAnyCalls(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM calls LIMIT 1").get());
  }

  getSessionRecap(since: number): {
    boldestCorrect: CallRecord | null;
    biggestCap: CallRecord | null;
    topProphet: { viewer_login: string; points: number } | null;
  } {
    const boldestCorrect = this.db.prepare(`SELECT * FROM calls WHERE created_at >= ? AND status = 'correct'
      ORDER BY boldness DESC, points_awarded DESC, resolved_at ASC LIMIT 1`).get(since) as CallRecord | undefined;
    const biggestCap = this.db.prepare(`SELECT * FROM calls WHERE created_at >= ? AND status = 'incorrect'
      ORDER BY boldness DESC, resolved_at ASC LIMIT 1`).get(since) as CallRecord | undefined;
    const topProphet = this.db.prepare(`SELECT viewer_login, SUM(points_awarded) AS points FROM calls
      WHERE created_at >= ? AND status = 'correct' GROUP BY viewer_id ORDER BY points DESC, viewer_login COLLATE NOCASE ASC LIMIT 1`)
      .get(since) as { viewer_login: string; points: number } | undefined;
    return { boldestCorrect: boldestCorrect ?? null, biggestCap: biggestCap ?? null, topProphet: topProphet ?? null };
  }

  resolveCall(id: number, status: "correct" | "incorrect" | "nuked", now = Date.now()):
    | { ok: true; call: CallRecord }
    | { ok: false; reason: "not_open" | "not_found" } {
    return this.db.transaction(() => {
      this.expireCalls(now);
      const call = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRecord | undefined;
      if (!call) return { ok: false as const, reason: "not_found" as const };
      if (call.status !== "open") return { ok: false as const, reason: "not_open" as const };
      const points = status === "correct"
        ? Math.round(10 * call.boldness * Math.min(2, 1 + Math.max(0, now - call.created_at) / (30 * 60 * 1000)))
        : 0;
      this.db.prepare("UPDATE calls SET status = ?, resolved_at = ?, points_awarded = ? WHERE id = ?")
        .run(status, now, points, id);
      if (points > 0) {
        this.db.prepare(`
          INSERT INTO leaderboard (viewer_id, viewer_login, points) VALUES (?, ?, ?)
          ON CONFLICT(viewer_id) DO UPDATE SET viewer_login = excluded.viewer_login, points = leaderboard.points + excluded.points
        `).run(call.viewer_id, call.viewer_login, points);
      }
      return { ok: true as const, call: this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRecord };
    })();
  }
}
