import {
  randomId,
  type Group,
  type Participant,
  validateName,
} from "../domain/group";
import type {
  GroupRealtimeEvent,
  GroupSpinState,
  SpinHistoryItem,
} from "../domain/realtime";
import type { Bindings, DurableObjectStateLike } from "../types";

type GroupState = {
  group: Group;
  participants: Participant[];
  version: number;
  spin: GroupSpinState;
  spinHistory: SpinHistoryItem[];
  pendingResultSpinId: string | null;
  pendingResultCounters: Record<string, number> | null;
  pendingResultExpiresAt: string | null;
};

type ErrorBody = {
  error: string;
};

const GROUP_STATE_KEY = "group-state";
const MAX_SPIN_HISTORY_ITEMS = 20;
const PENDING_RESULT_TTL_MS = 10 * 60 * 1000;
type CloudflareWebSocket = WebSocket & { accept(): void };

type ParticipantLike = Omit<Participant, "spinsSinceLastWon"> & {
  spinsSinceLastWon?: unknown;
};

type SpinHistoryItemLike = Omit<SpinHistoryItem, "participants"> & {
  participants?: ParticipantLike[];
};

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

function cloneParticipants(participants: ParticipantLike[]): Participant[] {
  return participants.map((participant) => normalizeParticipant(participant));
}

function normalizeParticipant(participant: ParticipantLike): Participant {
  return {
    ...participant,
    spinsSinceLastWon:
      typeof participant.spinsSinceLastWon === "number" &&
      Number.isFinite(participant.spinsSinceLastWon) &&
      participant.spinsSinceLastWon >= 0
        ? Math.floor(participant.spinsSinceLastWon)
        : 0,
  };
}

function cloneSpinHistoryItem(item: SpinHistoryItemLike): SpinHistoryItem {
  return {
    id: item.id,
    createdAt: item.createdAt,
    winnerParticipantId: item.winnerParticipantId,
    participants: cloneParticipants(item.participants ?? []),
  };
}

function cloneSpinHistory(items: SpinHistoryItemLike[]): SpinHistoryItem[] {
  return items.map((item) => cloneSpinHistoryItem(item));
}

function participantWeight(participant: Participant): number {
  return Math.max(1, participant.spinsSinceLastWon + 1);
}

function pickWeightedWinner(participants: Participant[]): Participant | null {
  let totalWeight = 0;
  for (const participant of participants) {
    totalWeight += participantWeight(participant);
  }

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return null;
  }

  let draw = Math.random() * totalWeight;
  for (const participant of participants) {
    draw -= participantWeight(participant);
    if (draw < 0) {
      return participant;
    }
  }

  return participants[participants.length - 1] ?? null;
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
          spinHistory: [],
          pendingResultSpinId: null,
          pendingResultCounters: null,
          pendingResultExpiresAt: null,
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
          spinsSinceLastWon: 0,
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

        const winner = pickWeightedWinner(eligibleParticipants);
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

      if (request.method === "GET" && url.pathname === "/history") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        return Response.json(cloneSpinHistory(current.spinHistory).reverse());
      }

      const historyPathMatch = url.pathname.match(/^\/history\/([^/]+)$/);
      const historySavePathMatch = url.pathname.match(/^\/history\/([^/]+)\/save$/);
      if (historySavePathMatch && request.method === "POST") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const spinId = historySavePathMatch[1];
        if (!spinId) {
          return this.error(400, "Spin id is required.");
        }

        if (current.pendingResultSpinId === spinId) {
          current.pendingResultSpinId = null;
          current.pendingResultCounters = null;
          current.pendingResultExpiresAt = null;
          const next = await this.bumpAndSave(current);
          this.broadcast({
            type: "spin.result.dismissed",
            groupId: next.group.id,
            version: next.version,
            ts: new Date().toISOString(),
            payload: {
              spinId,
              action: "save",
            },
          });
        }

        return new Response(null, { status: 204 });
      }

      if (historyPathMatch && request.method === "DELETE") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const spinId = historyPathMatch[1];
        if (!spinId) {
          return this.error(400, "Spin id is required.");
        }

        const nowTs = Date.now();
        const pendingExpiryTs = current.pendingResultExpiresAt
          ? Date.parse(current.pendingResultExpiresAt)
          : Number.NaN;
        const isPendingExpired =
          Number.isFinite(pendingExpiryTs) && pendingExpiryTs > 0 && pendingExpiryTs < nowTs;
        const hadPendingResult =
          current.pendingResultSpinId === spinId &&
          !isPendingExpired &&
          current.pendingResultCounters !== null;

        const revertedParticipants: Participant[] = [];
        if (hadPendingResult && current.pendingResultCounters) {
          for (const participant of current.participants) {
            const previousCounter = current.pendingResultCounters[participant.id];
            if (typeof previousCounter === "number" && Number.isFinite(previousCounter)) {
              participant.spinsSinceLastWon = Math.max(0, Math.floor(previousCounter));
              revertedParticipants.push({ ...participant });
            }
          }
        }

        current.spinHistory = current.spinHistory.filter((item) => item.id !== spinId);
        if (current.pendingResultSpinId === spinId || isPendingExpired) {
          current.pendingResultSpinId = null;
          current.pendingResultCounters = null;
          current.pendingResultExpiresAt = null;
        }
        const next = await this.bumpAndSave(current);

        if (hadPendingResult) {
          for (const participant of revertedParticipants) {
            this.broadcast({
              type: "participant.updated",
              groupId: next.group.id,
              version: next.version,
              ts: new Date().toISOString(),
              payload: {
                participant,
              },
            });
          }

          this.broadcast({
            type: "spin.result.dismissed",
            groupId: next.group.id,
            version: next.version,
            ts: new Date().toISOString(),
            payload: {
              spinId,
              action: "discard",
            },
          });
        }

        return new Response(null, { status: 204 });
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
    const winnerParticipantId = current.spin.winnerParticipantId;
    const completedSpinId = current.spin.spinId;

    if (!winnerParticipantId || !completedSpinId) {
      return;
    }

    current.spin = {
      ...current.spin,
      status: "idle",
      resolvedAt,
    };

    const previousCounters: Record<string, number> = {};
    const updatedParticipants: Participant[] = [];
    for (const participant of current.participants) {
      if (!participant.active) {
        continue;
      }

      previousCounters[participant.id] = participant.spinsSinceLastWon;
      if (participant.id === winnerParticipantId) {
        participant.spinsSinceLastWon = 0;
      } else {
        participant.spinsSinceLastWon += 1;
      }
      updatedParticipants.push({ ...participant });
    }

    current.spinHistory.push({
      id: completedSpinId,
      createdAt: resolvedAt,
      participants: cloneParticipants(
        current.participants.filter((participant) => participant.active),
      ),
      winnerParticipantId,
    });
    current.spinHistory = current.spinHistory.slice(-MAX_SPIN_HISTORY_ITEMS);
    current.pendingResultSpinId = completedSpinId;
    current.pendingResultCounters = previousCounters;
    current.pendingResultExpiresAt = new Date(Date.now() + PENDING_RESULT_TTL_MS).toISOString();

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

    for (const participant of updatedParticipants) {
      this.broadcast({
        type: "participant.updated",
        groupId: current.group.id,
        version: current.version,
        ts: new Date().toISOString(),
        payload: {
          participant,
        },
      });
    }
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
      participants: cloneParticipants((data.participants ?? []) as ParticipantLike[]),
      version: typeof data.version === "number" ? data.version : 0,
      spin: data.spin ? cloneSpinState(data.spin) : cloneSpinState(DEFAULT_SPIN_STATE),
      spinHistory: cloneSpinHistory((data.spinHistory ?? []) as SpinHistoryItemLike[]),
      pendingResultSpinId: data.pendingResultSpinId ?? null,
      pendingResultCounters:
        data.pendingResultCounters && typeof data.pendingResultCounters === "object"
          ? Object.fromEntries(
              Object.entries(data.pendingResultCounters).flatMap(([participantId, count]) =>
                typeof count === "number" && Number.isFinite(count)
                  ? [[participantId, Math.max(0, Math.floor(count))]]
                  : [],
              ),
            )
          : null,
      pendingResultExpiresAt:
        typeof data.pendingResultExpiresAt === "string" ? data.pendingResultExpiresAt : null,
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
