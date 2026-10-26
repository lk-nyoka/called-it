import type { Server, IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import type { ContextEntry } from "../core/context.js";
import type { JudgeSuggestion } from "../judge/types.js";

export type OverlayCall = { id: number; viewerLogin: string; text: string; createdAt: number; boldness: number };
export type OverlayJury = { callId: number; viewerLogin: string; callText: string; durationMs: number; remainingMs: number; receipts: number; cap: number };
export type SessionRecap = {
  boldestCorrect: { viewer_login: string; text: string; boldness: number; points_awarded: number } | null;
  biggestCap: { viewer_login: string; text: string; boldness: number } | null;
  topProphet: { viewer_login: string; points: number } | null;
};
export type OverlayEvent =
  | { type: "state"; openCalls: OverlayCall[]; hasHadCalls?: boolean; jury?: OverlayJury }
  | { type: "jury:start"; callId: number; viewerLogin: string; callText: string; durationMs?: number; receipts?: number; cap?: number }
  | { type: "jury:update"; callId: number; receipts: number; cap: number }
  | { type: "jury:end"; callId: number }
  | { type: "called-it"; viewerLogin: string; callText: string; calledAgo: string; points: number }
  | { type: "hall-of-cap"; viewerLogin: string; callText: string }
  | { type: "judge:state"; enabled: boolean }
  | { type: "judge:suggestions"; suggestions: JudgeSuggestion[] }
  | { type: "leaderboard"; leaders: Array<{ viewerLogin: string; points: number }> }
  | { type: "session:recap"; recap: SessionRecap }
  | { type: "context"; entry: ContextEntry };

let overlayServer: WebSocketServer | undefined;

export function attachOverlayBus(
  server: Server,
  getOpenCalls: () => OverlayCall[],
  getJury?: () => OverlayJury | undefined,
  getHasHadCalls: () => boolean = () => getOpenCalls().length > 0,
): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true });
  overlayServer = sockets;
  sockets.on("connection", (client) => {
    const jury = getJury?.();
    client.send(JSON.stringify({ type: "state", openCalls: getOpenCalls(), hasHadCalls: getHasHadCalls(), ...(jury ? { jury } : {}) } satisfies OverlayEvent));
  });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const origin = request.headers.origin;
    let sameOrigin = true;
    if (origin) {
      try {
        const protocol = request.socket instanceof TLSSocket ? "https" : "http";
        sameOrigin = new URL(origin).origin === new URL(`${protocol}://${request.headers.host}`).origin;
      } catch { sameOrigin = false; }
    }
    if (pathname !== "/ws" || !sameOrigin) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  return sockets;
}

export function broadcastOverlayEvent(event: OverlayEvent): void {
  if (!overlayServer) return;
  const message = JSON.stringify(event);
  for (const client of overlayServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}
