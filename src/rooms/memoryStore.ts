export type ParticipantRole = "host" | "guest";

export type RoomParticipant = {
  participantId: string;
  displayName: string | null;
  role: ParticipantRole;
  joinedAt: number;
};

export type RoomSummary = {
  roomId: string;
  createdAt: number;
  participants: RoomParticipant[];
};

export type CreateRoomResult = {
  roomId: string;
  hostToken: string;
  createdAt: number;
};

export type JoinRoomOptions = {
  displayName?: string | null;
  role?: ParticipantRole | null;
  hostToken?: string | null;
};

export type JoinRoomResult = {
  roomId: string;
  participantId: string;
  role: ParticipantRole;
  displayName: string | null;
  joinedAt: number;
};

class RoomStoreError extends Error {}

export class RoomNotFoundError extends RoomStoreError {
  constructor(roomId: string) {
    super(`Room ${roomId} not found`);
  }
}

export class InvalidHostTokenError extends RoomStoreError {
  constructor() {
    super("Host token is invalid for this room");
  }
}

const ROOM_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_ID_LENGTH = 6;

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2);

const normalizeRoomId = (value: string) => value.trim().toUpperCase();

const generateRoomId = (existingIds: Set<string>) => {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    let code = "";
    const randomBytes = new Uint32Array(ROOM_ID_LENGTH);

    if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
      crypto.getRandomValues(randomBytes);
    } else {
      for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
        randomBytes[index] = Math.floor(Math.random() * ROOM_ID_ALPHABET.length);
      }
    }

    for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
      const randomValue = randomBytes[index] % ROOM_ID_ALPHABET.length;
      code += ROOM_ID_ALPHABET[randomValue];
    }

    const normalized = normalizeRoomId(code);
    if (!existingIds.has(normalized)) {
      return normalized;
    }
  }

  throw new Error("Failed to allocate a unique room id");
};

type RoomRecord = {
  id: string;
  createdAt: number;
  hostToken: string;
  participants: Map<string, RoomParticipant>;
};

export class InMemoryRoomStore {
  #rooms: Map<string, RoomRecord>;

  constructor() {
    this.#rooms = new Map();
  }

  createRoom(): CreateRoomResult {
    const ids = new Set(this.#rooms.keys());
    const roomId = generateRoomId(ids);
    const hostToken = makeId();
    const createdAt = Date.now();

    this.#rooms.set(roomId, {
      id: roomId,
      createdAt,
      hostToken,
      participants: new Map(),
    });

    return {
      roomId,
      hostToken,
      createdAt,
    };
  }

  joinRoom(roomIdRaw: string, options: JoinRoomOptions = {}): JoinRoomResult {
    if (typeof roomIdRaw !== "string" || roomIdRaw.trim().length === 0) {
      throw new RoomNotFoundError(roomIdRaw);
    }

    const roomId = normalizeRoomId(roomIdRaw);
    const room = this.#rooms.get(roomId);
    if (!room) {
      throw new RoomNotFoundError(roomId);
    }

    const role: ParticipantRole = options.role === "host" ? "host" : "guest";
    const displayName =
      typeof options.displayName === "string" && options.displayName.trim().length > 0
        ? options.displayName.trim()
        : null;

    if (role === "host") {
      if (!options.hostToken || options.hostToken !== room.hostToken) {
        throw new InvalidHostTokenError();
      }
    }

    const participantId = makeId();
    const joinedAt = Date.now();

    const participant: RoomParticipant = {
      participantId,
      displayName,
      role,
      joinedAt,
    };

    room.participants.set(participantId, participant);

    return {
      roomId,
      participantId,
      role,
      displayName,
      joinedAt,
    };
  }

  getRoomSummary(roomIdRaw: string): RoomSummary {
    const roomId = normalizeRoomId(roomIdRaw);
    const room = this.#rooms.get(roomId);
    if (!room) {
      throw new RoomNotFoundError(roomId);
    }

    return {
      roomId,
      createdAt: room.createdAt,
      participants: Array.from(room.participants.values()).map((participant) => ({
        participantId: participant.participantId,
        displayName: participant.displayName,
        role: participant.role,
        joinedAt: participant.joinedAt,
      })),
    };
  }

  hasRoom(roomIdRaw: string): boolean {
    if (typeof roomIdRaw !== "string") {
      return false;
    }

    const roomId = normalizeRoomId(roomIdRaw);
    return this.#rooms.has(roomId);
  }

  inspectRoom(roomIdRaw: string): RoomRecord | null {
    const roomId = normalizeRoomId(roomIdRaw);
    return this.#rooms.get(roomId) ?? null;
  }
}

export const roomStore = new InMemoryRoomStore();
