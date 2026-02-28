import type { Group, Participant } from "./group";

export type GroupSpinState = {
  status: "idle" | "spinning";
  spinId: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  winnerParticipantId: string | null;
  durationMs: number | null;
  extraTurns: number | null;
};

type EventEnvelope<TType extends string, TPayload> = {
  type: TType;
  groupId: string;
  version: number;
  ts: string;
  payload: TPayload;
};

export type GroupSnapshotEvent = EventEnvelope<
  "snapshot",
  {
    group: Group;
    participants: Participant[];
    spin: GroupSpinState;
  }
>;

export type ParticipantAddedEvent = EventEnvelope<
  "participant.added",
  {
    participant: Participant;
  }
>;

export type ParticipantUpdatedEvent = EventEnvelope<
  "participant.updated",
  {
    participant: Participant;
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

export type GroupRealtimeEvent =
  | GroupSnapshotEvent
  | ParticipantAddedEvent
  | ParticipantUpdatedEvent
  | ParticipantRemovedEvent
  | SpinStartedEvent
  | SpinResolvedEvent;
