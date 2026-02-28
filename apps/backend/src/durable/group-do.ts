import {
  randomId,
  type Group,
  type Participant,
  validateName,
} from "../domain/group";
import type { GroupRealtimeEvent, GroupSpinState } from "../domain/realtime";
import type { Bindings, DurableObjectStateLike } from "../types";

type GroupState = {
  group: Group;
  participants: Participant[];
  version: number;
  spin: GroupSpinState;
};

type ErrorBody = {
  error: string;
};

const GROUP_STATE_KEY = "group-state";
type CloudflareWebSocket = WebSocket & { accept(): void };

const DEFAULT_SPIN_STATE: GroupSpinState = {
  status: "idle",
  spinId: null,
  startedAt: null,
  resolvedAt: null,
  winnerParticipantId: null,
  durationMs: null,
  extraTurns: null,
};

function cloneSpinState(state: GroupSpinState): GroupSpinState {
  return {
    status: state.status,
    spinId: state.spinId,
    startedAt: state.startedAt,
    resolvedAt: state.resolvedAt,
    winnerParticipantId: state.winnerParticipantId,
    durationMs: state.durationMs,
    extraTurns: state.extraTurns,
  };
}

export class GroupDurableObject {
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly _env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/init") {
        const body = (await request.json()) as { group: Group };
        const groupName = validateName(body.group.name);

        const nextState: GroupState = {
          group: {
            ...body.group,
            name: groupName,
          },
          participants: [],
          version: 0,
          spin: cloneSpinState(DEFAULT_SPIN_STATE),
        };

        await this.state.storage.put(GROUP_STATE_KEY, nextState);
        return Response.json(nextState.group, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/ws") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const WebSocketPairCtor = globalThis as unknown as {
          WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
        };
        const pair = new WebSocketPairCtor.WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.acceptSocket(server, current);

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }

      if (request.method === "GET" && url.pathname === "/group") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        return Response.json(current.group);
      }

      if (request.method === "GET" && url.pathname === "/participants") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        return Response.json(current.participants);
      }

      if (request.method === "POST" && url.pathname === "/participants") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const body = (await request.json()) as { name?: string };
        const name = validateName(body.name ?? "");

        if (
          current.participants.some(
            (participant) => participant.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          return this.error(409, "Participant with this name already exists.");
        }

        const participant: Participant = {
          id: randomId(),
          name,
          active: true,
        };

        current.participants.push(participant);

        const next = await this.bumpAndSave(current);
        this.broadcast({
          type: "participant.added",
          groupId: next.group.id,
          version: next.version,
          ts: new Date().toISOString(),
          payload: {
            participant,
          },
        });

        return Response.json(participant, { status: 201 });
      }

      if (request.method === "POST" && url.pathname === "/spin") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        if (current.spin.status === "spinning") {
          return this.error(409, "A spin is already in progress.");
        }

        const eligibleParticipants = current.participants.filter((participant) => participant.active);
        if (eligibleParticipants.length < 2) {
          return this.error(409, "Need at least 2 active participants to spin.");
        }

        const winner =
          eligibleParticipants[Math.floor(Math.random() * eligibleParticipants.length)] ?? null;
        if (!winner) {
          return this.error(500, "Unable to resolve winner.");
        }

        const spinId = randomId();
        const durationMs = 4000 + Math.floor(Math.random() * 2000);
        const extraTurns = 6 + Math.floor(Math.random() * 3);
        const startedAt = new Date().toISOString();

        current.spin = {
          status: "spinning",
          spinId,
          startedAt,
          resolvedAt: null,
          winnerParticipantId: winner.id,
          durationMs,
          extraTurns,
        };

        const startedState = await this.bumpAndSave(current);

        this.broadcast({
          type: "spin.started",
          groupId: startedState.group.id,
          version: startedState.version,
          ts: new Date().toISOString(),
          payload: {
            spin: cloneSpinState(startedState.spin),
          },
        });

        setTimeout(() => {
          void this.resolveSpin(spinId);
        }, durationMs);

        return Response.json({ spin: startedState.spin }, { status: 202 });
      }

      const participantsPathMatch = url.pathname.match(/^\/participants\/([^/]+)$/);
      if (participantsPathMatch && request.method === "PATCH") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const participantId = participantsPathMatch[1];
        if (!participantId) {
          return this.error(400, "Participant id is required.");
        }
        const body = (await request.json()) as { active?: boolean };

        if (typeof body.active !== "boolean") {
          return this.error(400, "active must be a boolean.");
        }

        const participant = current.participants.find((item) => item.id === participantId);
        if (!participant) {
          return this.error(404, "Participant not found.");
        }

        participant.active = body.active;

        const next = await this.bumpAndSave(current);
        this.broadcast({
          type: "participant.updated",
          groupId: next.group.id,
          version: next.version,
          ts: new Date().toISOString(),
          payload: {
            participant,
          },
        });

        return Response.json(participant);
      }

      if (participantsPathMatch && request.method === "DELETE") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const participantId = participantsPathMatch[1];
        if (!participantId) {
          return this.error(400, "Participant id is required.");
        }
        const previousCount = current.participants.length;
        current.participants = current.participants.filter(
          (participant) => participant.id !== participantId,
        );

        if (current.participants.length === previousCount) {
          return this.error(404, "Participant not found.");
        }

        const next = await this.bumpAndSave(current);
        this.broadcast({
          type: "participant.removed",
          groupId: next.group.id,
          version: next.version,
          ts: new Date().toISOString(),
          payload: {
            participantId,
          },
        });

        return new Response(null, { status: 204 });
      }

      return this.error(404, "Not found.");
    } catch (error) {
      if (error instanceof Error) {
        return this.error(400, error.message);
      }

      return this.error(500, "Internal server error.");
    }
  }

  private acceptSocket(socket: WebSocket, current: GroupState): void {
    const acceptedSocket = socket as CloudflareWebSocket;
    acceptedSocket.accept();

    const clientId = randomId();
    this.sockets.set(clientId, socket);

    const snapshotEvent: GroupRealtimeEvent = {
      type: "snapshot",
      groupId: current.group.id,
      version: current.version,
      ts: new Date().toISOString(),
      payload: {
        group: current.group,
        participants: current.participants,
        spin: cloneSpinState(current.spin),
      },
    };

    this.send(acceptedSocket, snapshotEvent, clientId);

    acceptedSocket.addEventListener("close", () => {
      this.sockets.delete(clientId);
    });

    acceptedSocket.addEventListener("error", () => {
      this.sockets.delete(clientId);
      try {
        acceptedSocket.close(1011, "Socket error");
      } catch {
        // no-op
      }
    });

    acceptedSocket.addEventListener("message", () => {
      // Currently server-push only.
    });
  }

  private async resolveSpin(spinId: string): Promise<void> {
    const current = await this.loadState();
    if (!current) {
      return;
    }

    if (current.spin.status !== "spinning" || current.spin.spinId !== spinId) {
      return;
    }

    const resolvedAt = new Date().toISOString();

    current.spin = {
      ...current.spin,
      status: "idle",
      resolvedAt,
    };

    current.version += 1;
    await this.saveState(current);

    this.broadcast({
      type: "spin.resolved",
      groupId: current.group.id,
      version: current.version,
      ts: new Date().toISOString(),
      payload: {
        spin: cloneSpinState(current.spin),
      },
    });
  }

  private send(socket: WebSocket, event: GroupRealtimeEvent, clientId?: string): void {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      if (clientId) {
        this.sockets.delete(clientId);
      }
      try {
        socket.close(1011, "Send failure");
      } catch {
        // no-op
      }
    }
  }

  private broadcast(event: GroupRealtimeEvent): void {
    for (const [clientId, socket] of this.sockets.entries()) {
      this.send(socket, event, clientId);
    }
  }

  private async loadState(): Promise<GroupState | null> {
    const data = await this.state.storage.get<GroupState>(GROUP_STATE_KEY);
    if (!data) {
      return null;
    }

    return {
      ...data,
      version: typeof data.version === "number" ? data.version : 0,
      spin: data.spin ? cloneSpinState(data.spin) : cloneSpinState(DEFAULT_SPIN_STATE),
    };
  }

  private async saveState(nextState: GroupState): Promise<void> {
    await this.state.storage.put(GROUP_STATE_KEY, nextState);
  }

  private async bumpAndSave(nextState: GroupState): Promise<GroupState> {
    nextState.version += 1;
    await this.saveState(nextState);
    return nextState;
  }

  private error(status: number, message: string): Response {
    return Response.json({ error: message } satisfies ErrorBody, { status });
  }
}
