import { describe, expect, it } from "vitest";
import type { GroupRealtimeCommand, GroupViewerIdentity, GroupRealtimeServerMessage } from "../domain/realtime";
import type { Bindings, DurableObjectStateLike, DurableObjectStorageLike } from "../types";
import { GroupDurableObject } from "./group-do";

const GROUP_STATE_KEY = "group-state";

class TestStorage implements DurableObjectStorageLike {
  private readonly values = new Map<string, unknown>();

  constructor(initialState: TestGroupState) {
    this.values.set(GROUP_STATE_KEY, initialState);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async getGroupState(): Promise<TestGroupState> {
    const value = this.values.get(GROUP_STATE_KEY);
    if (!value) {
      throw new Error("Missing group state.");
    }

    return value as TestGroupState;
  }
}

class FakeSocket {
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {}
}

function createBindings(): Bindings {
  return {
    FRONTEND_URL: "http://localhost:3000",
    CLERK_SECRET_KEY: "test-secret",
    GROUPS_DO: {
      idFromName(): object {
        return {};
      },
      get() {
        throw new Error("Not used in test.");
      },
    },
    GROUP_INDEX_KV: {
      async get(): Promise<string | null> {
        return null;
      },
      async put(): Promise<void> {},
      async delete(): Promise<void> {},
      async list() {
        return { keys: [], list_complete: true };
      },
    },
  };
}

function createInitialState() {
  return {
    group: {
      id: "group-1",
      name: "The Wheel",
      createdAt: "2026-03-09T00:00:00.000Z",
      ownerUserId: "owner-user",
      ownerEmail: "owner@example.com",
      ownerParticipantId: "participant-owner",
    },
    participants: [
      {
        id: "participant-owner",
        name: "Owner",
        active: true,
        emailId: "owner@example.com",
        manager: true,
        spinsSinceLastWon: 0,
      },
      {
        id: "participant-a",
        name: "Alice",
        active: true,
        emailId: "alice@example.com",
        manager: false,
        spinsSinceLastWon: 2,
      },
      {
        id: "participant-b",
        name: "Bob",
        active: true,
        emailId: "bob@example.com",
        manager: false,
        spinsSinceLastWon: 3,
      },
    ],
    version: 0,
    spin: {
      status: "idle" as const,
      spinId: null,
      startedAt: null,
      resolvedAt: null,
      winnerParticipantId: null,
      targetAngle: null,
      durationMs: null,
      extraTurns: null,
    },
    spinHistory: [],
    pendingResultSpinId: null,
    pendingResultCounters: null,
    pendingResultExpiresAt: null,
  };
}

type TestGroupState = ReturnType<typeof createInitialState>;

function createViewerIdentity(overrides: Partial<GroupViewerIdentity> = {}): GroupViewerIdentity {
  return {
    userId: null,
    verifiedEmails: [],
    primaryEmail: null,
    firstName: null,
    lastName: null,
    ...overrides,
  };
}

async function sendCommand(
  durableObject: GroupDurableObject,
  viewer: GroupViewerIdentity,
  command: GroupRealtimeCommand,
) {
  const socket = new FakeSocket();
  const client = {
    clientId: "client-1",
    socket: socket as unknown as WebSocket,
    viewer,
  };

  await (durableObject as unknown as { handleSocketMessage(client: unknown, data: unknown): Promise<void> })
    .handleSocketMessage(client, JSON.stringify(command));

  const messages = socket.sent.map((payload) => JSON.parse(payload) as GroupRealtimeServerMessage);
  return { socket, messages };
}

function participantSetActiveCommand(participantId: string, active: unknown): GroupRealtimeCommand {
  return {
    type: "participant.setActive",
    requestId: `request-${participantId}-${String(active)}`,
    payload: {
      participantId,
      active: active as boolean,
    },
  };
}

describe("GroupDurableObject participant access", () => {
  it("allows a participant to mark another participant absent", async () => {
    const storage = new TestStorage(createInitialState());
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["alice@example.com"] }),
      participantSetActiveCommand("participant-b", false),
    );

    expect(result.messages.at(-1)?.type).toBe("command.ok");
    const state = await storage.getGroupState();
    expect(state.participants.find((participant) => participant.id === "participant-b")?.active).toBe(false);
  });

  it("allows a participant to mark another participant present", async () => {
    const initialState = createInitialState();
    initialState.participants[2]!.active = false;
    const storage = new TestStorage(initialState);
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["alice@example.com"] }),
      participantSetActiveCommand("participant-b", true),
    );

    expect(result.messages.at(-1)?.type).toBe("command.ok");
    const state = await storage.getGroupState();
    expect(state.participants.find((participant) => participant.id === "participant-b")?.active).toBe(true);
  });

  it("allows the owner to mark any participant absent", async () => {
    const storage = new TestStorage(createInitialState());
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ userId: "owner-user" }),
      participantSetActiveCommand("participant-a", false),
    );

    expect(result.messages.at(-1)?.type).toBe("command.ok");
    const state = await storage.getGroupState();
    expect(state.participants.find((participant) => participant.id === "participant-a")?.active).toBe(false);
  });

  it("rejects a non-participant from toggling presence", async () => {
    const storage = new TestStorage(createInitialState());
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["outsider@example.com"] }),
      participantSetActiveCommand("participant-a", false),
    );

    expect(result.messages.at(-1)).toMatchObject({
      type: "command.error",
      payload: {
        status: 403,
        error: "You do not have access to this group.",
      },
    });
  });

  it("rejects unknown participant ids", async () => {
    const storage = new TestStorage(createInitialState());
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["alice@example.com"] }),
      participantSetActiveCommand("missing-participant", false),
    );

    expect(result.messages.at(-1)).toMatchObject({
      type: "command.error",
      payload: {
        status: 400,
        error: "Participant not found.",
      },
    });
  });

  it("rejects invalid active payload types", async () => {
    const storage = new TestStorage(createInitialState());
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["alice@example.com"] }),
      participantSetActiveCommand("participant-b", "yes"),
    );

    expect(result.messages.at(-1)).toMatchObject({
      type: "command.error",
      payload: {
        status: 400,
        error: "active must be a boolean.",
      },
    });
  });

  it("allows a participant to start a spin even when they are absent", async () => {
    const initialState = createInitialState();
    initialState.participants[1]!.active = false;
    const storage = new TestStorage(initialState);
    const durableObject = new GroupDurableObject({ storage } satisfies DurableObjectStateLike, createBindings());

    const result = await sendCommand(
      durableObject,
      createViewerIdentity({ verifiedEmails: ["alice@example.com"] }),
      {
        type: "spin.start",
        requestId: "request-spin",
        payload: {},
      },
    );

    expect(result.messages.at(-1)?.type).toBe("command.ok");
    const state = await storage.getGroupState();
    expect(state.spin.status).toBe("spinning");
  });
});
