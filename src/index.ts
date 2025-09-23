import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { WebSocket } from "ws";

type IncomingClientMessage = {
  type: "chat";
  text: string;
  messageId?: string;
};

type WelcomeEvent = {
  type: "welcome";
  clientId: string;
};

type ChatEvent = {
  type: "chat";
  clientId: string;
  text: string;
  messageId: string;
  timestamp: number;
};

type OutgoingServerMessage = WelcomeEvent | ChatEvent;

type ClientSession = {
  id: string;
  socket: WSContext<WebSocket>;
};

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const app = new Hono();

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({
  app,
  baseUrl: `http://localhost:${port}`,
});

const sessions = new Map<string, ClientSession>();

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const sendJson = (
  socket: WSContext<WebSocket>,
  payload: OutgoingServerMessage
) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    console.error("Failed to send WebSocket payload", error);
  }
};

const broadcast = (payload: ChatEvent) => {
  for (const client of sessions.values()) {
    sendJson(client.socket, payload);
  }
};

app.get("/", (c) => {
  return c.json({
    service: "werewolf-signaling",
    mode: "poc",
    uptime: process.uptime(),
  });
});

app.get("/healthz", (c) => {
  return c.json({ status: "ok" });
});

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const requestId = c.req.header("x-request-id") ?? makeId();
    const clientId = makeId();

    return {
      onOpen(_event, ws) {
        sessions.set(clientId, { id: clientId, socket: ws });
        console.log(`[ws] open requestId=${requestId} clientId=${clientId}`);
        sendJson(ws, { type: "welcome", clientId });
      },
      onMessage(event) {
        let payload: IncomingClientMessage | null = null;
        try {
          payload = JSON.parse(
            typeof event.data === "string" ? event.data : String(event.data)
          );
        } catch (error) {
          console.warn(`[ws] invalid json requestId=${requestId}`, error);
          return;
        }

        if (
          !payload ||
          payload.type !== "chat" ||
          typeof payload.text !== "string"
        ) {
          return;
        }

        const messageId =
          payload.messageId && typeof payload.messageId === "string"
            ? payload.messageId
            : makeId();

        const chatEvent: ChatEvent = {
          type: "chat",
          clientId,
          text: payload.text,
          messageId,
          timestamp: Date.now(),
        };

        broadcast(chatEvent);
      },
      onClose(event) {
        sessions.delete(clientId);
        console.log(
          `[ws] close requestId=${requestId} clientId=${clientId} code=${event.code}`
        );
      },
      onError(error, ws) {
        sessions.delete(clientId);
        console.error(
          `[ws] error requestId=${requestId} clientId=${clientId}`,
          error
        );
        try {
          ws.close(1011, "internal-error");
        } catch (closeError) {
          console.error("[ws] failed to close socket", closeError);
        }
      },
    };
  })
);

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(
      `werewolf-signaling listening on http://localhost:${info.port}`
    );
    console.log(`Render-ready mode with websocket endpoint at /ws`);
  }
);

injectWebSocket(server);
