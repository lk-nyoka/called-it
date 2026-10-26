import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { app } from "./server.js";
import { isHelpCommand } from "./chat/commands.js";

describe("!help command", () => {
  it("matches case-insensitively with surrounding spaces", () => {
    expect(isHelpCommand("  !HeLp ")).toBe(true);
    expect(isHelpCommand("!calledit")).toBe(true);
    expect(isHelpCommand("!call prediction")).toBe(false);
  });
});

describe("GET /health", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("returns status ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("keeps the callback and status routes ahead of the role route", async () => {
    const status = await fetch(`${baseUrl}/auth/status`);
    expect(status.status).toBe(200);

    const callback = await fetch(`${baseUrl}/auth/callback?state=invalid&code=invalid`);
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("state was invalid");
  });

  it("serves the transparent OBS overlay page", async () => {
    const response = await fetch(`${baseUrl}/overlay?test=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Called It — Twitch overlay");
  });

  it("serves the streamer console and reports its initial state", async () => {
    const page = await fetch(`${baseUrl}/console`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("What’s happening");

    const state = await fetch(`${baseUrl}/api/console/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual(expect.objectContaining({
      openCalls: expect.any(Array),
      context: expect.any(Array),
      judgeEnabled: expect.any(Boolean),
      activeJury: null,
    }));
  });

  it("serves the console manual jury control and validates its open endpoint", async () => {
    const script = await fetch(`${baseUrl}/console/console.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("Open jury");
    const invalid = await fetch(`${baseUrl}/api/jury/not-an-id/open`, { method: "POST" });
    expect(invalid.status).toBe(400);
  });

  it("blocks cross-origin writes to local console APIs", async () => {
    const response = await fetch(`${baseUrl}/api/judge`, {
      method: "POST",
      headers: { Origin: `https://${new URL(baseUrl).host}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This local control is only available from the Called It page." });
  });
});
