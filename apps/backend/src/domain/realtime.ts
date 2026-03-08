import type { Group, Participant } from "./group";

export type RealtimeGroup = Pick<Group, "id" | "name" | "createdAt"> &
  Partial<Pick<Group, "ownerUserId" | "ownerEmail" | "ownerParticipantId">>;

export type RealtimeParticipant = Pick<
  Participant,
  "id" | "name" | "active" | "spinsSinceLastWon"
> &
  Partial<Pick<Participant, "emailId" | "manager">>;

export type SpinHistoryItem = {
  id: string;
  createdAt: string;
  participants: RealtimeParticipant[];
  winnerParticipantId: string;
};

export type GroupSpinState = {
  status: "idle" | "spinning";
  spinId: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  winnerParticipantId: string | null;
  targetAngle: number | null;
  durationMs: number | null;
  extraTurns: number | null;
};

export type GroupViewerIdentity = {
  userId: string | null;
  verifiedEmails: string[];
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
};

export type GroupViewerAccess = {
  isOwner: boolean;
  isParticipant: boolean;
  isManager: boolean;
  participantId: string | null;
};

export type GroupSocketSnapshot = {
  group: RealtimeGroup;
  participants: RealtimeParticipant[];
  spin: GroupSpinState;
  history: SpinHistoryItem[];
  viewer: GroupViewerAccess;
};

export type GroupIndexSync = {
  group?: Group;
  participants?: Participant[];
};

type EventEnvelope<TType extends string, TPayload> = {
  type: TType;
  groupId: string;
  version: number;
  ts: string;
  payload: TPayload;
};

type CommandEnvelope<TType extends string, TPayload> = {
  type: TType;
  requestId: string;
  payload: TPayload;
};

export type LoadHistoryCommand = CommandEnvelope<
  "load.history",
  Record<string, never>
>;

export type RenameGroupCommand = CommandEnvelope<
  "group.rename",
  {
    name: string;
  }
>;

export type SpinStartCommand = CommandEnvelope<
  "spin.start",
  Record<string, never>
>;

export type SaveHistoryCommand = CommandEnvelope<
  "history.save",
  {
    spinId: string;
  }
>;

export type DiscardHistoryCommand = CommandEnvelope<
  "history.discard",
  {
    spinId: string;
  }
>;

export type SetParticipantActiveCommand = CommandEnvelope<
  "participant.setActive",
  {
    participantId: string;
    active: boolean;
  }
>;

export type CommitParticipantsCommand = CommandEnvelope<
  "participants.commit",
  {
    adds: Array<{ name: string; emailId: string | null; manager: boolean }>;
    updates: Array<{ participantId: string; emailId: string | null; manager: boolean }>;
    removes: string[];
  }
>;

export type GroupRealtimeCommand =
  | LoadHistoryCommand
  | RenameGroupCommand
  | SpinStartCommand
  | SaveHistoryCommand
  | DiscardHistoryCommand
  | SetParticipantActiveCommand
  | CommitParticipantsCommand;

export type GroupSnapshotEvent = EventEnvelope<
  "snapshot",
  GroupSocketSnapshot
>;

export type HistorySnapshotEvent = EventEnvelope<
  "history.snapshot",
  {
    history: SpinHistoryItem[];
  }
>;

export type ParticipantAddedEvent = EventEnvelope<
  "participant.added",
  {
    participant: RealtimeParticipant;
  }
>;

export type ParticipantUpdatedEvent = EventEnvelope<
  "participant.updated",
  {
    participant: RealtimeParticipant;
  }
>;

export type ParticipantRemovedEvent = EventEnvelope<
  "participant.removed",
  {
    participantId: string;
  }
>;

export type SpinStartedEvent = EventEnvelope<
  "spin.started",
  {
    spin: GroupSpinState;
  }
>;

export type SpinResolvedEvent = EventEnvelope<
  "spin.resolved",
  {
    spin: GroupSpinState;
  }
>;

export type SpinResultDismissedEvent = EventEnvelope<
  "spin.result.dismissed",
  {
    spinId: string;
    action: "save" | "discard";
  }
>;

export type GroupUpdatedEvent = EventEnvelope<
  "group.updated",
  {
    group: RealtimeGroup;
  }
>;

export type GroupCommandOkMessage = EventEnvelope<
  "command.ok",
  {
    requestId: string;
    commandType: GroupRealtimeCommand["type"];
    sync?: GroupIndexSync;
  }
>;

export type GroupCommandErrorMessage = EventEnvelope<
  "command.error",
  {
    requestId: string;
    commandType: GroupRealtimeCommand["type"];
    error: string;
    status: number;
  }
>;

export type GroupRealtimeEvent =
  | GroupSnapshotEvent
  | HistorySnapshotEvent
  | GroupUpdatedEvent
  | ParticipantAddedEvent
  | ParticipantUpdatedEvent
  | ParticipantRemovedEvent
  | SpinStartedEvent
  | SpinResolvedEvent
  | SpinResultDismissedEvent;

export type GroupRealtimeServerMessage =
  | GroupRealtimeEvent
  | GroupCommandOkMessage
  | GroupCommandErrorMessage;
