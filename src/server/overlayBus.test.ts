import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket, type WebSocketServer } from "ws";
import { attachOverlayBus, broadcastOverlayEvent } from "./overlayBus.js";

describe("overlay WebSocket bus", () => {
  let server: Server;
  let bus: WebSocketServer;
  let client: WebSocket;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    bus = attachOverlayBus(
      server,
      () => [{ id: 7, viewerLogin: "streamprophet", text: "the boss drops a key", createdAt: 1, boldness: 2 }],
      () => ({ callId: 7, viewerLogin: "streamprophet", callText: "the boss drops a key", durationMs: 10_000, remainingMs: 8_500, receipts: 2, cap: 1 }),
    );
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    baseUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterAll(async () => {
    client?.close();
    await new Promise<void>((resolve) => bus.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends the current ticker state and broadcasts live jury updates", async () => {
    client = new WebSocket(baseUrl);
    const initialMessage = new Promise<unknown>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    await new Promise<void>((resolve) => client.once("open", () => resolve()));
    expect(await initialMessage).toEqual({
      type: "state",
      openCalls: [{ id: 7, viewerLogin: "streamprophet", text: "the boss drops a key", createdAt: 1, boldness: 2 }],
      hasHadCalls: true,
      jury: { callId: 7, viewerLogin: "streamprophet", callText: "the boss drops a key", durationMs: 10_000, remainingMs: 8_500, receipts: 2, cap: 1 },
    });

    const nextMessage = new Promise<unknown>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    broadcastOverlayEvent({ type: "jury:update", callId: 7, receipts: 4, cap: 1 });
    expect(await nextMessage).toEqual({ type: "jury:update", callId: 7, receipts: 4, cap: 1 });

    const startMessage = new Promise<unknown>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    broadcastOverlayEvent({ type: "jury:start", callId: 7, viewerLogin: "streamprophet", callText: "the boss drops a key", durationMs: 10_000, receipts: 0, cap: 0 });
    expect(await startMessage).toEqual({ type: "jury:start", callId: 7, viewerLogin: "streamprophet", callText: "the boss drops a key", durationMs: 10_000, receipts: 0, cap: 0 });

    const endMessage = new Promise<unknown>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    broadcastOverlayEvent({ type: "jury:end", callId: 7 });
    expect(await endMessage).toEqual({ type: "jury:end", callId: 7 });

    const suggestionMessage = new Promise<unknown>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    const suggestions = [{ callId: 7, confidence: 0.8, evidence: "the boss drops a key", contextId: 2, contextTimestamp: 100 }];
    broadcastOverlayEvent({ type: "judge:suggestions", suggestions });
    expect(await suggestionMessage).toEqual({ type: "judge:suggestions", suggestions });
  });
});
