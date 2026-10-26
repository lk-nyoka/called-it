import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CallStore } from "./callStore.js";

describe("CallStore", () => {
  let store: CallStore;
  afterEach(() => store?.close());

  it("enforces one open call per viewer and the 30-call global cap", () => {
    store = new CallStore(":memory:");
    expect(store.createCall({ viewerId: "1", viewerLogin: "one", text: "first call" }).ok).toBe(true);
    expect(store.createCall({ viewerId: "1", viewerLogin: "one", text: "second call" })).toEqual({ ok: false, reason: "already_open" });

    for (let id = 2; id <= 30; id++) {
      expect(store.createCall({ viewerId: String(id), viewerLogin: `viewer${id}`, text: "a prediction" }).ok).toBe(true);
    }
    expect(store.createCall({ viewerId: "31", viewerLogin: "viewer31", text: "one too many" })).toEqual({ ok: false, reason: "cap" });
  });

  it("expires calls at 30 minutes and frees the viewer's open slot", () => {
    store = new CallStore(":memory:");
    const createdAt = 1_000;
    const created = store.createCall({ viewerId: "1", viewerLogin: "one", text: "expires soon", now: createdAt });
    expect(created.ok).toBe(true);
    expect(store.expireCalls(createdAt + 30 * 60 * 1000)).toBe(1);
    expect(store.getCall(created.ok ? created.call.id : -1)?.status).toBe("expired");
    expect(store.createCall({ viewerId: "1", viewerLogin: "one", text: "new prediction", now: createdAt + 30 * 60 * 1000 }).ok).toBe(true);
  });

  it("awards correct calls points to the persistent leaderboard", () => {
    store = new CallStore(":memory:");
    const created = store.createCall({ viewerId: "1", viewerLogin: "one", text: "a good prediction", now: 0 });
    if (!created.ok) throw new Error("call was not created");
    const resolved = store.resolveCall(created.call.id, "correct", 15 * 60 * 1000);
    expect(resolved.ok && resolved.call.points_awarded).toBe(30);
    expect(store.getLeaderboard()).toEqual([{ viewer_id: "1", viewer_login: "one", points: 30 }]);
    expect(store.resolveCall(created.call.id, "incorrect")).toEqual({ ok: false, reason: "not_open" });
  });

  it("stores boldness and uses it in the points formula", () => {
    store = new CallStore(":memory:");
    const created = store.createCall({ viewerId: "1", viewerLogin: "one", text: "a bold prediction", boldness: 5, now: 1_000 });
    if (!created.ok) throw new Error("call was not created");
    expect(created.call.boldness).toBe(5);
    const resolved = store.resolveCall(created.call.id, "correct", 1_000);
    expect(resolved.ok && resolved.call.points_awarded).toBe(50);
  });

  it("migrates an existing database by assigning old calls the default boldness", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "called-it-migration-"));
    const filename = path.join(directory, "old.db");
    const oldDatabase = new Database(filename);
    oldDatabase.exec(`CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      viewer_id TEXT NOT NULL,
      viewer_login TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      points_awarded INTEGER NOT NULL DEFAULT 0
    ); INSERT INTO calls (viewer_id, viewer_login, text, status, created_at, expires_at)
      VALUES ('old-viewer', 'oldviewer', 'an old call', 'open', 100, 1800100);`);
    oldDatabase.close();
    const migrated = new CallStore(filename);
    try {
      expect(migrated.getCall(1)?.boldness).toBe(2);
    } finally {
      migrated.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
