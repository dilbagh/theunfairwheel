import { randomId, type Group, type Participant, validateName } from "../domain/group";
import type {
  CommitParticipantsCommand,
  GroupCommandErrorMessage,
  GroupCommandOkMessage,
  GroupRealtimeCommand,
  GroupRealtimeEvent,
  GroupRealtimeServerMessage,
  RealtimeGroup,
  RealtimeParticipant,
  GroupSocketSnapshot,
  GroupSpinState,
  GroupViewerAccess,
  GroupViewerIdentity,
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

type GroupSocketClient = {
  clientId: string;
  socket: WebSocket;
  viewer: GroupViewerIdentity;
};

const GROUP_STATE_KEY = "group-state";
const MAX_SPIN_HISTORY_ITEMS = 20;
const PENDING_RESULT_TTL_MS = 10 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VIEWER_HEADER = "x-group-viewer";
const ANONYMOUS_VIEWER: GroupViewerIdentity = {
  userId: null,
  verifiedEmails: [],
  primaryEmail: null,
  firstName: null,
  lastName: null,
};

type CloudflareWebSocket = WebSocket & { accept(): void };

type ParticipantLike = Omit<Participant, "emailId" | "manager" | "spinsSinceLastWon"> & {
  emailId?: unknown;
  manager?: unknown;
  spinsSinceLastWon?: unknown;
};

type SpinHistoryItemLike = Omit<SpinHistoryItem, "participants"> & {
  participants?: ParticipantLike[];
};

type GroupViewerIdentityLike = {
  userId?: unknown;
  verifiedEmails?: unknown;
  primaryEmail?: unknown;
  firstName?: unknown;
  lastName?: unknown;
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
  const emailId =
    typeof participant.emailId === "string" &&
    participant.emailId.trim() &&
    EMAIL_PATTERN.test(participant.emailId.trim())
      ? participant.emailId.trim()
      : null;

  return {
    ...participant,
    emailId,
    manager: typeof participant.manager === "boolean" ? participant.manager && emailId !== null : false,
    spinsSinceLastWon:
      typeof participant.spinsSinceLastWon === "number" &&
      Number.isFinite(participant.spinsSinceLastWon) &&
      participant.spinsSinceLastWon >= 0
        ? Math.floor(participant.spinsSinceLastWon)
        : 0,
  };
}

function normalizeEmailId(emailId: unknown): string | null {
  if (typeof emailId === "undefined" || emailId === null) {
    return null;
  }

  if (typeof emailId !== "string") {
    throw new Error("emailId must be a string.");
  }

  const trimmed = emailId.trim();
  if (!trimmed) {
    return null;
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new Error("emailId must be a valid email address.");
  }

  return trimmed;
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

function decodeViewerIdentity(encoded: string | null): GroupViewerIdentity | null {
  if (!encoded) {
    return ANONYMOUS_VIEWER;
  }

  try {
    const parsed = JSON.parse(atob(encoded)) as GroupViewerIdentityLike;
    const userId =
      typeof parsed.userId === "string" && parsed.userId.trim().length > 0
        ? parsed.userId.trim()
        : null;

    return {
      userId,
      verifiedEmails: Array.isArray(parsed.verifiedEmails)
        ? parsed.verifiedEmails.flatMap((email) =>
            typeof email === "string" && email.trim().length > 0 ? [email.trim().toLowerCase()] : [],
          )
        : [],
      primaryEmail:
        typeof parsed.primaryEmail === "string" && parsed.primaryEmail.trim().length > 0
          ? parsed.primaryEmail.trim().toLowerCase()
          : null,
      firstName: typeof parsed.firstName === "string" && parsed.firstName.trim() ? parsed.firstName.trim() : null,
      lastName: typeof parsed.lastName === "string" && parsed.lastName.trim() ? parsed.lastName.trim() : null,
    };
  } catch {
    return null;
  }
}

function isAnonymousViewer(viewer: GroupViewerIdentity): boolean {
  return viewer.userId === null && viewer.verifiedEmails.length === 0;
}

function toRealtimeGroup(group: RealtimeGroup, viewer: GroupViewerIdentity): RealtimeGroup {
  if (isAnonymousViewer(viewer)) {
    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
    };
  }

  return {
    ...group,
  };
}

function toRealtimeParticipant(
  participant: RealtimeParticipant,
  viewer: GroupViewerIdentity,
): RealtimeParticipant {
  if (isAnonymousViewer(viewer)) {
    return {
      id: participant.id,
      name: participant.name,
      active: participant.active,
      spinsSinceLastWon: participant.spinsSinceLastWon,
    };
  }

  return {
    ...participant,
  };
}

function toRealtimeHistoryItem(item: SpinHistoryItem, viewer: GroupViewerIdentity): SpinHistoryItem {
  return {
    ...item,
    participants: item.participants.map((participant) => toRealtimeParticipant(participant, viewer)),
  };
}

function sanitizeMessageForViewer(
  message: GroupRealtimeServerMessage,
  viewer: GroupViewerIdentity,
): GroupRealtimeServerMessage {
  if (!isAnonymousViewer(viewer)) {
    return message;
  }

  switch (message.type) {
    case "snapshot":
      return {
        ...message,
        payload: {
          ...message.payload,
          group: toRealtimeGroup(message.payload.group, viewer),
          participants: message.payload.participants.map((participant) =>
            toRealtimeParticipant(participant, viewer),
          ),
          history: message.payload.history.map((item) => toRealtimeHistoryItem(item, viewer)),
        },
      };
    case "history.snapshot":
      return {
        ...message,
        payload: {
          history: message.payload.history.map((item) => toRealtimeHistoryItem(item, viewer)),
        },
      };
    case "group.updated":
      return {
        ...message,
        payload: {
          group: toRealtimeGroup(message.payload.group, viewer),
        },
      };
    case "participant.added":
    case "participant.updated":
      return {
        ...message,
        payload: {
          participant: toRealtimeParticipant(message.payload.participant, viewer),
        },
      };
    default:
      return message;
  }
}

export class GroupDurableObject {
  private readonly sockets = new Map<string, GroupSocketClient>();

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly _env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/init") {
        const body = (await request.json()) as { group: Group; ownerParticipant: Participant };
        const groupName = validateName(body.group.name);
        const ownerParticipant = normalizeParticipant(body.ownerParticipant);

        if (ownerParticipant.id !== body.group.ownerParticipantId) {
          return this.error(400, "Owner participant id mismatch.");
        }
        if (!ownerParticipant.emailId) {
          return this.error(400, "Owner participant must have a valid emailId.");
        }
        if (!ownerParticipant.manager) {
          return this.error(400, "Owner participant must be a manager.");
        }

        const nextState: GroupState = {
          group: {
            ...body.group,
            name: groupName,
          },
          participants: [
            {
              ...ownerParticipant,
              active: true,
              manager: true,
              emailId: ownerParticipant.emailId,
            },
          ],
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

        const viewer = decodeViewerIdentity(request.headers.get(VIEWER_HEADER));
        if (!viewer) {
          return this.error(400, "Invalid viewer identity.");
        }

        const WebSocketPairCtor = globalThis as unknown as {
          WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
        };
        const pair = new WebSocketPairCtor.WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        this.acceptSocket(server, viewer, current);

        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }

      return this.error(404, "Not found.");
    } catch (error) {
      if (error instanceof Error) {
        return this.error(400, error.message);
      }

      return this.error(500, "Internal server error.");
    }
  }

  private acceptSocket(socket: WebSocket, viewer: GroupViewerIdentity, current: GroupState): void {
    const acceptedSocket = socket as CloudflareWebSocket;
    acceptedSocket.accept();

    const clientId = randomId();
    const client: GroupSocketClient = {
      clientId,
      socket,
      viewer,
    };
    this.sockets.set(clientId, client);

    this.send(acceptedSocket, this.snapshotEvent(current, viewer), clientId);

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

    acceptedSocket.addEventListener("message", (event) => {
      void this.handleSocketMessage(client, event.data);
    });
  }

  private async handleSocketMessage(client: GroupSocketClient, data: unknown): Promise<void> {
    let command: GroupRealtimeCommand;

    try {
      command = JSON.parse(String(data)) as GroupRealtimeCommand;
    } catch {
      this.send(
        client.socket,
        this.commandError("unknown", "load.history", 400, "Malformed socket payload."),
        client.clientId,
      );
      return;
    }

    if (
      !command ||
      typeof command !== "object" ||
      typeof command.type !== "string" ||
      typeof command.requestId !== "string" ||
      !command.requestId
    ) {
      this.send(
        client.socket,
        this.commandError("unknown", "load.history", 400, "Malformed socket command."),
        client.clientId,
      );
      return;
    }

    const current = await this.loadState();
    if (!current) {
      this.send(
        client.socket,
        this.commandError(command.requestId, command.type, 404, "Group not found."),
        client.clientId,
      );
      return;
    }

    const access = this.resolveViewerAccess(current, client.viewer);

    try {
      switch (command.type) {
        case "load.history":
          this.requireParticipantAccess(access);
          this.send(client.socket, this.historySnapshotEvent(current), client.clientId);
          this.send(client.socket, this.commandOk(current, command.requestId, command.type), client.clientId);
          return;
        case "group.rename":
          this.requireManagerAccess(access);
          await this.handleRenameGroup(client, current, command);
          return;
        case "spin.start":
          this.requireParticipantAccess(access);
          await this.handleStartSpin(client, current, command);
          return;
        case "history.save":
          this.requireParticipantAccess(access);
          await this.handleSaveHistory(client, current, command);
          return;
        case "history.discard":
          this.requireParticipantAccess(access);
          await this.handleDiscardHistory(client, current, command);
          return;
        case "participant.setActive":
          this.requireParticipantAccess(access);
          if (access.participantId !== command.payload.participantId && !access.isManager) {
            throw new Error("Manager access is required.");
          }
          await this.handleSetParticipantActive(client, current, command);
          return;
        case "participants.commit":
          this.requireManagerAccess(access);
          await this.handleCommitParticipants(client, current, command);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";
      const status =
        message === "Authentication required."
          ? 401
          : message === "You do not have access to this group."
            ? 403
            : message === "Manager access is required."
              ? 403
              : 400;

      this.send(
        client.socket,
        this.commandError(command.requestId, command.type, status, message),
        client.clientId,
      );
    }
  }

  private requireParticipantAccess(access: GroupViewerAccess): void {
    if (!access.isParticipant && !access.isOwner) {
      throw new Error("You do not have access to this group.");
    }
  }

  private requireManagerAccess(access: GroupViewerAccess): void {
    if (!access.isManager) {
      throw new Error("Manager access is required.");
    }
  }

  private resolveViewerAccess(current: GroupState, viewer: GroupViewerIdentity): GroupViewerAccess {
    const participant = current.participants.find((candidate) => {
      if (!candidate.emailId) {
        return false;
      }

      return viewer.verifiedEmails.includes(candidate.emailId.trim().toLowerCase());
    });

    const isOwner = viewer.userId === current.group.ownerUserId;

    return {
      isOwner,
      isParticipant: Boolean(participant),
      isManager: isOwner || Boolean(participant?.manager),
      participantId: participant?.id ?? null,
    };
  }

  private snapshotEvent(current: GroupState, viewer: GroupViewerIdentity): GroupRealtimeEvent {
    const payload: GroupSocketSnapshot = {
      group: toRealtimeGroup(current.group, viewer),
      participants: current.participants.map((participant) => toRealtimeParticipant(participant, viewer)),
      spin: cloneSpinState(current.spin),
      history: cloneSpinHistory(current.spinHistory)
        .reverse()
        .map((item) => toRealtimeHistoryItem(item, viewer)),
      viewer: this.resolveViewerAccess(current, viewer),
    };

    return {
      type: "snapshot",
      groupId: current.group.id,
      version: current.version,
      ts: new Date().toISOString(),
      payload,
    };
  }

  private historySnapshotEvent(current: GroupState): GroupRealtimeEvent {
    return {
      type: "history.snapshot",
      groupId: current.group.id,
      version: current.version,
      ts: new Date().toISOString(),
      payload: {
        history: cloneSpinHistory(current.spinHistory).reverse(),
      },
    };
  }

  private commandOk(
    current: GroupState,
    requestId: string,
    commandType: GroupRealtimeCommand["type"],
    sync?: GroupCommandOkMessage["payload"]["sync"],
  ): GroupCommandOkMessage {
    return {
      type: "command.ok",
      groupId: current.group.id,
      version: current.version,
      ts: new Date().toISOString(),
      payload: {
        requestId,
        commandType,
        sync,
      },
    };
  }

  private commandError(
    requestId: string,
    commandType: GroupRealtimeCommand["type"],
    status: number,
    error: string,
  ): GroupCommandErrorMessage {
    return {
      type: "command.error",
      groupId: "",
      version: 0,
      ts: new Date().toISOString(),
      payload: {
        requestId,
        commandType,
        error,
        status,
      },
    };
  }

  private async handleRenameGroup(
    client: GroupSocketClient,
    current: GroupState,
    command: Extract<GroupRealtimeCommand, { type: "group.rename" }>,
  ): Promise<void> {
    const nextName = validateName(command.payload.name);

    if (current.group.name !== nextName) {
      current.group = {
        ...current.group,
        name: nextName,
      };

      const next = await this.bumpAndSave(current);
      this.broadcast({
        type: "group.updated",
        groupId: next.group.id,
        version: next.version,
        ts: new Date().toISOString(),
        payload: {
          group: next.group,
        },
      });
      this.send(
        client.socket,
        this.commandOk(next, command.requestId, command.type, { group: next.group }),
        client.clientId,
      );
      return;
    }

    this.send(
      client.socket,
      this.commandOk(current, command.requestId, command.type, { group: current.group }),
      client.clientId,
    );
  }

  private async handleStartSpin(
    client: GroupSocketClient,
    current: GroupState,
    command: Extract<GroupRealtimeCommand, { type: "spin.start" }>,
  ): Promise<void> {
    if (current.spin.status === "spinning") {
      throw new Error("A spin is already in progress.");
    }

    const eligibleParticipants = current.participants.filter((participant) => participant.active);
    if (eligibleParticipants.length < 2) {
      throw new Error("Need at least 2 active participants to spin.");
    }

    const winner = pickWeightedWinner(eligibleParticipants);
    if (!winner) {
      throw new Error("Unable to resolve winner.");
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

    this.send(
      client.socket,
      this.commandOk(startedState, command.requestId, command.type),
      client.clientId,
    );

    setTimeout(() => {
      void this.resolveSpin(spinId);
    }, durationMs);
  }

  private async handleSaveHistory(
    client: GroupSocketClient,
    current: GroupState,
    command: Extract<GroupRealtimeCommand, { type: "history.save" }>,
  ): Promise<void> {
    const spinId = command.payload.spinId;
    if (!spinId) {
      throw new Error("Spin id is required.");
    }

    if (current.pendingResultSpinId === spinId) {
      current.pendingResultSpinId = null;
      current.pendingResultCounters = null;
      current.pendingResultExpiresAt = null;
      current = await this.bumpAndSave(current);
      this.broadcast({
        type: "spin.result.dismissed",
        groupId: current.group.id,
        version: current.version,
        ts: new Date().toISOString(),
        payload: {
          spinId,
          action: "save",
        },
      });
      this.broadcast(this.historySnapshotEvent(current));
    }

    this.send(client.socket, this.commandOk(current, command.requestId, command.type), client.clientId);
  }

  private async handleDiscardHistory(
    client: GroupSocketClient,
    current: GroupState,
    command: Extract<GroupRealtimeCommand, { type: "history.discard" }>,
  ): Promise<void> {
    const spinId = command.payload.spinId;
    if (!spinId) {
      throw new Error("Spin id is required.");
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

    this.broadcast(this.historySnapshotEvent(next));
    this.send(client.socket, this.commandOk(next, command.requestId, command.type), client.clientId);
  }

  private async handleSetParticipantActive(
    client: GroupSocketClient,
    current: GroupState,
    command: Extract<GroupRealtimeCommand, { type: "participant.setActive" }>,
  ): Promise<void> {
    const participant = current.participants.find((item) => item.id === command.payload.participantId);
    if (!participant) {
      throw new Error("Participant not found.");
    }

    if (typeof command.payload.active !== "boolean") {
      throw new Error("active must be a boolean.");
    }

    participant.active = command.payload.active;
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

    this.send(
      client.socket,
      this.commandOk(next, command.requestId, command.type, { participants: next.participants }),
      client.clientId,
    );
  }

  private async handleCommitParticipants(
    client: GroupSocketClient,
    current: GroupState,
    command: CommitParticipantsCommand,
  ): Promise<void> {
    const body = command.payload;
    if (typeof body !== "object" || body === null) {
      throw new Error("Invalid request body.");
    }

    const adds = body.adds ?? [];
    const updates = body.updates ?? [];
    const removes = body.removes ?? [];

    if (!Array.isArray(adds) || !Array.isArray(updates) || !Array.isArray(removes)) {
      throw new Error("adds, updates, and removes must be arrays.");
    }

    const currentById = new Map(current.participants.map((participant) => [participant.id, participant]));

    const removeSet = new Set<string>();
    for (const participantId of removes) {
      if (typeof participantId !== "string" || !participantId) {
        throw new Error("Each remove id must be a non-empty string.");
      }
      if (!currentById.has(participantId)) {
        throw new Error(`Participant not found: ${participantId}`);
      }
      if (removeSet.has(participantId)) {
        throw new Error(`Duplicate remove participant id: ${participantId}`);
      }
      if (participantId === current.group.ownerParticipantId) {
        throw new Error("Owner participant cannot be removed.");
      }
      removeSet.add(participantId);
    }

    const updateMap = new Map<string, { emailId: string | null; manager: boolean }>();
    for (const update of updates) {
      if (typeof update !== "object" || update === null) {
        throw new Error("Each update entry must be an object.");
      }

      const participantId = update.participantId;
      if (typeof participantId !== "string" || !participantId) {
        throw new Error("Each update participantId must be a non-empty string.");
      }
      if (!currentById.has(participantId)) {
        throw new Error(`Participant not found: ${participantId}`);
      }
      if (removeSet.has(participantId)) {
        throw new Error(`Participant cannot be both updated and removed: ${participantId}`);
      }
      if (updateMap.has(participantId)) {
        throw new Error(`Duplicate update participant id: ${participantId}`);
      }

      const currentParticipant = currentById.get(participantId);
      if (!currentParticipant) {
        throw new Error(`Participant not found: ${participantId}`);
      }
      if (participantId === current.group.ownerParticipantId) {
        if (typeof update.emailId !== "undefined") {
          const nextOwnerEmail = normalizeEmailId(update.emailId);
          if (nextOwnerEmail !== currentParticipant.emailId) {
            throw new Error("Owner participant email cannot be changed.");
          }
        }
        if (typeof update.manager !== "undefined" && update.manager !== true) {
          throw new Error("Owner participant must remain a manager.");
        }
      }

      let emailId = currentParticipant.emailId;
      if (typeof update.emailId !== "undefined") {
        emailId = normalizeEmailId(update.emailId);
      }

      let manager = currentParticipant.manager;
      if (typeof update.manager !== "undefined") {
        if (typeof update.manager !== "boolean") {
          throw new Error("manager must be a boolean.");
        }
        manager = update.manager;
      }

      if (manager && !emailId) {
        throw new Error("manager requires a valid emailId.");
      }
      if (!emailId) {
        manager = false;
      }

      updateMap.set(participantId, { emailId, manager });
    }

    const existingNames = new Set(
      current.participants
        .filter((participant) => !removeSet.has(participant.id))
        .map((participant) => participant.name.toLowerCase()),
    );
    const addedParticipants: Participant[] = [];
    for (const add of adds) {
      if (typeof add !== "object" || add === null) {
        throw new Error("Each add entry must be an object.");
      }

      const name = validateName(add.name ?? "");
      const normalizedName = name.toLowerCase();
      if (existingNames.has(normalizedName)) {
        throw new Error("Participant with this name already exists.");
      }
      existingNames.add(normalizedName);

      if (typeof add.manager !== "undefined" && typeof add.manager !== "boolean") {
        throw new Error("manager must be a boolean.");
      }

      const emailId = normalizeEmailId(add.emailId);
      const manager = add.manager === true;
      if (manager && !emailId) {
        throw new Error("manager requires a valid emailId.");
      }

      addedParticipants.push({
        id: randomId(),
        name,
        active: true,
        emailId,
        manager,
        spinsSinceLastWon: 0,
      });
    }

    current.participants = current.participants
      .filter((participant) => !removeSet.has(participant.id))
      .map((participant) => {
        const updated = updateMap.get(participant.id);
        if (!updated) {
          return participant;
        }
        if (participant.id === current.group.ownerParticipantId) {
          return {
            ...participant,
            active: true,
            emailId: participant.emailId,
            manager: true,
          };
        }
        return {
          ...participant,
          emailId: updated.emailId,
          manager: updated.manager,
        };
      });

    current.participants.push(...addedParticipants);

    const next = await this.bumpAndSave(current);
    const ts = new Date().toISOString();

    for (const participantId of removeSet) {
      this.broadcast({
        type: "participant.removed",
        groupId: next.group.id,
        version: next.version,
        ts,
        payload: {
          participantId,
        },
      });
    }

    for (const [participantId] of updateMap) {
      const participant = next.participants.find((item) => item.id === participantId);
      if (!participant) {
        continue;
      }

      this.broadcast({
        type: "participant.updated",
        groupId: next.group.id,
        version: next.version,
        ts,
        payload: {
          participant,
        },
      });
    }

    for (const participant of addedParticipants) {
      this.broadcast({
        type: "participant.added",
        groupId: next.group.id,
        version: next.version,
        ts,
        payload: {
          participant,
        },
      });
    }

    this.broadcastSnapshots(next);
    this.send(
      client.socket,
      this.commandOk(next, command.requestId, command.type, { participants: next.participants }),
      client.clientId,
    );
  }

  private broadcastSnapshots(current: GroupState): void {
    for (const [clientId, client] of this.sockets.entries()) {
      this.send(client.socket, this.snapshotEvent(current, client.viewer), clientId);
    }
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
      participants: cloneParticipants(current.participants.filter((participant) => participant.active)),
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

    this.broadcast(this.historySnapshotEvent(current));
  }

  private send(socket: WebSocket, message: GroupRealtimeServerMessage, clientId?: string): void {
    const viewer = clientId ? this.sockets.get(clientId)?.viewer : null;
    const outboundMessage = viewer ? sanitizeMessageForViewer(message, viewer) : message;

    try {
      socket.send(JSON.stringify(outboundMessage));
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

  private broadcast(message: GroupRealtimeEvent): void {
    for (const [clientId, client] of this.sockets.entries()) {
      this.send(client.socket, message, clientId);
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
