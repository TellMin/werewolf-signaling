import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { WebSocket } from "ws";

import {
  InvalidHostTokenError,
  RoomNotFoundError,
  roomStore,
  type ParticipantRole,
} from "./rooms/memoryStore.js";

type JoinMessage = {
  type: "join";
  roomId?: string;
  displayName?: string;
  role?: ParticipantRole;
  hostToken?: string;
};

type SignalMessage = {
  type: "signal";
  targetClientId?: string;
  payload?: unknown;
};

type ChatMessage = {
  type: "chat";
  text?: string;
  messageId?: string;
};

type IncomingClientMessage = JoinMessage | SignalMessage | ChatMessage;

type WelcomeEvent = {
  type: "welcome";
  clientId: string;
};

type ParticipantSummary = {
  clientId: string;
  displayName: string | null;
  role: ParticipantRole;
};

type RoomStateEvent = {
  type: "room-state";
  participants: ParticipantSummary[];
};

type UserJoinedEvent = {
  type: "user-joined";
  participant: ParticipantSummary;
};

type UserLeftEvent = {
  type: "user-left";
  clientId: string;
};

type SignalRelayEvent = {
  type: "signal";
  from: string;
  payload: unknown;
};

type ChatEvent = {
  type: "chat";
  clientId: string;
  text: string;
  messageId: string;
  timestamp: number;
};

type OutgoingServerMessage =
  | WelcomeEvent
  | RoomStateEvent
  | UserJoinedEvent
  | UserLeftEvent
  | SignalRelayEvent
  | ChatEvent;

type ClientSession = {
  id: string;
  socket: WSContext<WebSocket>;
  roomId: string | null;
  displayName: string | null;
  role: ParticipantRole;
};

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const app = new Hono();

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({
  app,
  baseUrl: `http://localhost:${port}`,
});

const sessions = new Map<string, ClientSession>();
const activeRooms = new Map<string, Map<string, ClientSession>>();

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

const broadcastToRoom = (roomId: string, payload: OutgoingServerMessage, exclude?: string) => {
  const room = activeRooms.get(roomId);
  if (!room) {
    return;
  }

  for (const [clientId, session] of room.entries()) {
    if (exclude && clientId === exclude) {
      continue;
    }
    sendJson(session.socket, payload);
  }
};

const detachFromRoom = (session: ClientSession) => {
  if (!session.roomId) {
    return;
  }

  const room = activeRooms.get(session.roomId);
  if (!room) {
    session.roomId = null;
    return;
  }

  room.delete(session.id);
  if (room.size === 0) {
    activeRooms.delete(session.roomId);
  }

  broadcastToRoom(
    session.roomId,
    {
      type: "user-left",
      clientId: session.id,
    },
    session.id
  );

  session.roomId = null;
};

const attachToRoom = (session: ClientSession, roomId: string) => {
  const normalizedId = roomId.trim().toUpperCase();
  let room = activeRooms.get(normalizedId);

  if (!room) {
    room = new Map();
    activeRooms.set(normalizedId, room);
  }

  room.set(session.id, session);
  session.roomId = normalizedId;
};

const handleJoinMessage = (session: ClientSession, message: JoinMessage) => {
  if (!message.roomId || typeof message.roomId !== "string") {
    return;
  }

  const role: ParticipantRole = message.role === "host" ? "host" : "guest";
  const displayName =
    typeof message.displayName === "string" && message.displayName.trim().length > 0
      ? message.displayName.trim()
      : null;

  const wasInRoom = session.roomId;
  if (wasInRoom) {
    detachFromRoom(session);
  }

  session.displayName = displayName;
  session.role = role;
  attachToRoom(session, message.roomId);

  const room = activeRooms.get(session.roomId!);
  const otherParticipants: ParticipantSummary[] = [];

  if (room) {
    for (const [clientId, member] of room.entries()) {
      if (clientId === session.id) {
        continue;
      }
      otherParticipants.push({
        clientId: member.id,
        displayName: member.displayName,
        role: member.role,
      });
    }
  }

  sendJson(session.socket, {
    type: "room-state",
    participants: otherParticipants,
  });

  broadcastToRoom(
    session.roomId!,
    {
      type: "user-joined",
      participant: {
        clientId: session.id,
        displayName: session.displayName,
        role: session.role,
      },
    },
    session.id
  );
};

const handleSignalMessage = (session: ClientSession, message: SignalMessage) => {
  if (!session.roomId || !message.targetClientId) {
    return;
  }

  const room = activeRooms.get(session.roomId);
  if (!room) {
    return;
  }

  const target = room.get(message.targetClientId);
  if (!target) {
    return;
  }

  sendJson(target.socket, {
    type: "signal",
    from: session.id,
    payload: message.payload ?? null,
  });
};

const handleChatMessage = (session: ClientSession, message: ChatMessage) => {
  if (!session.roomId || typeof message.text !== "string") {
    return;
  }

  const roomEvent: ChatEvent = {
    type: "chat",
    clientId: session.id,
    text: message.text,
    messageId: message.messageId && typeof message.messageId === "string" ? message.messageId : makeId(),
    timestamp: Date.now(),
  };

  broadcastToRoom(session.roomId, roomEvent);
};

app.post("/rooms", async (c) => {
  try {
    // Consume request body to avoid hanging connections even when unused.
    if (c.req.header("content-length")) {
      try {
        await c.req.json();
      } catch {
        // Ignore malformed bodies; room creation does not require payload.
      }
    }
  } catch {
    // Swallow errors from body parsing to ensure idempotent room creation.
  }

  const result = roomStore.createRoom();

  return c.json(
    {
      roomId: result.roomId,
      hostToken: result.hostToken,
      createdAt: result.createdAt,
    },
    201
  );
});

app.post("/rooms/:roomId/join", async (c) => {
  const roomId = c.req.param("roomId");

  let payload: unknown = null;
  try {
    payload = await c.req.json();
  } catch (error) {
    if (c.req.header("content-length")) {
      console.warn(
        `[http] join payload parse error roomId=${roomId}`,
        error
      );
      return c.json(
        {
          error: "invalid_payload",
          message: "Request body must be valid JSON",
        },
        400
      );
    }
  }

  const rawDisplayName =
    payload && typeof payload === "object" && "displayName" in payload
      ? (payload as Record<string, unknown>).displayName ?? null
      : null;

  const displayName =
    typeof rawDisplayName === "string" && rawDisplayName.trim().length > 0
      ? rawDisplayName.trim()
      : null;

  const requestedRole =
    payload && typeof payload === "object" && "role" in payload
      ? (payload as Record<string, unknown>).role ?? null
      : null;

  const hostToken =
    payload && typeof payload === "object" && "hostToken" in payload
      ? (payload as Record<string, unknown>).hostToken ?? null
      : null;

  const role: ParticipantRole = requestedRole === "host" ? "host" : "guest";

  try {
    const joinResult = roomStore.joinRoom(roomId, {
      displayName,
      role,
      hostToken: typeof hostToken === "string" ? hostToken : null,
    });

    const summary = roomStore.getRoomSummary(roomId);

    return c.json(
      {
        roomId: joinResult.roomId,
        participantId: joinResult.participantId,
        role: joinResult.role,
        displayName: joinResult.displayName,
        joinedAt: joinResult.joinedAt,
        createdAt: summary.createdAt,
        participants: summary.participants.map((participant) => ({
          participantId: participant.participantId,
          displayName: participant.displayName,
          role: participant.role,
          joinedAt: participant.joinedAt,
        })),
      },
      200
    );
  } catch (error) {
    if (error instanceof RoomNotFoundError) {
      return c.json(
        {
          error: "room_not_found",
          message: "Specified room does not exist",
        },
        404
      );
    }

    if (error instanceof InvalidHostTokenError) {
      return c.json(
        {
          error: "invalid_host_token",
          message: "Host token is invalid for this room",
        },
        403
      );
    }

    console.error("[http] join unexpected error", error);
    return c.json(
      {
        error: "internal_error",
        message: "Failed to join room",
      },
      500
    );
  }
});

app.get("/", (c) => {
  return c.json({
    service: "werewolf-signaling",
    mode: "mesh-mvp",
    uptime: process.uptime(),
    rooms: activeRooms.size,
    clients: sessions.size,
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
        const session: ClientSession = {
          id: clientId,
          socket: ws,
          roomId: null,
          displayName: null,
          role: "guest",
        };
        sessions.set(clientId, session);
        console.log(`[ws] open requestId=${requestId} clientId=${clientId}`);
        sendJson(ws, { type: "welcome", clientId });
      },
      onMessage(event) {
        const session = sessions.get(clientId);
        if (!session) {
          return;
        }

        let payload: IncomingClientMessage | null = null;
        try {
          payload = JSON.parse(
            typeof event.data === "string" ? event.data : String(event.data)
          );
        } catch (error) {
          console.warn(`[ws] invalid json requestId=${requestId}`, error);
          return;
        }

        if (!payload || typeof payload !== "object") {
          return;
        }

        switch (payload.type) {
          case "join":
            handleJoinMessage(session, payload);
            break;
          case "signal":
            handleSignalMessage(session, payload);
            break;
          case "chat":
            handleChatMessage(session, payload);
            break;
          default:
            break;
        }
      },
      onClose(event) {
        const session = sessions.get(clientId);
        if (session) {
          detachFromRoom(session);
          sessions.delete(clientId);
        }
        console.log(
          `[ws] close requestId=${requestId} clientId=${clientId} code=${event.code}`
        );
      },
      onError(error, ws) {
        const session = sessions.get(clientId);
        if (session) {
          detachFromRoom(session);
          sessions.delete(clientId);
        }
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
    console.log(`WebSocket endpoint at /ws`);
  }
);

injectWebSocket(server);
