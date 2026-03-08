import { useAuth } from "@clerk/clerk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectGroupRealtime, type GroupRealtimeStatus } from "./group-realtime";
import type {
  Group,
  GroupRealtimeEvent,
  GroupRealtimeServerMessage,
  GroupSocketSnapshot,
  GroupSpinState,
  GroupViewerAccess,
  Participant,
  SpinHistoryItem,
} from "./groups";

type GroupSessionState = {
  group: Group | null;
  participants: Participant[];
  history: SpinHistoryItem[];
  spin: GroupSpinState;
  viewer: GroupViewerAccess | null;
  dismissedSpinResult: {
    spinId: string;
    action: "save" | "discard";
    version: number;
  } | null;
  isLoading: boolean;
  error: Error | null;
  status: GroupRealtimeStatus;
};

type UseGroupSessionResult = GroupSessionState & {
  request(command: Parameters<ReturnType<typeof connectGroupRealtime>["request"]>[0]): Promise<void>;
};

const EMPTY_HISTORY: SpinHistoryItem[] = [];
const EMPTY_PARTICIPANTS: Participant[] = [];

function dedupeParticipantsById(participants: Participant[]): Participant[] {
  const seen = new Set<string>();
  const result: Participant[] = [];

  for (const participant of participants) {
    if (seen.has(participant.id)) {
      continue;
    }

    seen.add(participant.id);
    result.push(participant);
  }

  return result;
}

function applyRealtimeEvent(snapshot: GroupSocketSnapshot, event: GroupRealtimeEvent): GroupSocketSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "history.snapshot":
      return {
        ...snapshot,
        history: event.payload.history,
      };
    case "group.updated":
      return {
        ...snapshot,
        group: event.payload.group,
      };
    case "participant.added":
      return {
        ...snapshot,
        participants: dedupeParticipantsById([...snapshot.participants, event.payload.participant]),
      };
    case "participant.updated":
      return {
        ...snapshot,
        participants: snapshot.participants.map((participant) =>
          participant.id === event.payload.participant.id ? event.payload.participant : participant,
        ),
      };
    case "participant.removed":
      return {
        ...snapshot,
        participants: snapshot.participants.filter(
          (participant) => participant.id !== event.payload.participantId,
        ),
      };
    case "spin.started":
    case "spin.resolved":
      return {
        ...snapshot,
        spin: event.payload.spin,
      };
    case "spin.result.dismissed":
      return snapshot;
    default:
      return snapshot;
  }
}

export function useGroupSession(groupId: string): UseGroupSessionResult {
  const { getToken } = useAuth();
  const connectionRef = useRef<ReturnType<typeof connectGroupRealtime> | null>(null);
  const snapshotRef = useRef<GroupSocketSnapshot | null>(null);
  const [state, setState] = useState<GroupSessionState>({
    group: null,
    participants: EMPTY_PARTICIPANTS,
    history: EMPTY_HISTORY,
    spin: EMPTY_SPIN,
    viewer: null,
    dismissedSpinResult: null,
    isLoading: true,
    error: null,
    status: "connecting",
  });

  useEffect(() => {
    const connection = connectGroupRealtime({
      groupId,
      getToken: () => getToken(),
      onStatusChange: (status) => {
        setState((current) => ({
          ...current,
          status,
          isLoading: current.group ? current.isLoading : status !== "closed",
          error:
            current.group || status !== "closed"
              ? current.error
              : new Error("Unable to establish realtime connection."),
        }));
      },
      onMessage: (message: GroupRealtimeServerMessage) => {
        if (message.type === "command.error" || message.type === "command.ok") {
          if (message.type === "command.error") {
            setState((current) => ({
              ...current,
              error: current.group ? current.error : new Error(message.payload.error),
            }));
          }
          return;
        }

        const nextSnapshot = applyRealtimeEvent(
          snapshotRef.current ?? {
            group: null as never,
            participants: EMPTY_PARTICIPANTS,
            history: EMPTY_HISTORY,
            spin: EMPTY_SPIN,
            viewer: {
              isOwner: false,
              isParticipant: false,
              isManager: false,
              participantId: null,
            },
          },
          message,
        );

        snapshotRef.current = nextSnapshot;
        setState({
          group: nextSnapshot.group,
          participants: nextSnapshot.participants,
          history: nextSnapshot.history,
          spin: nextSnapshot.spin,
          viewer: nextSnapshot.viewer,
          dismissedSpinResult:
            message.type === "spin.result.dismissed"
              ? {
                  spinId: message.payload.spinId,
                  action: message.payload.action,
                  version: message.version,
                }
              : null,
          isLoading: false,
          error: null,
          status: nextSnapshot ? "open" : "connecting",
        });
      },
    });

    connectionRef.current = connection;
    snapshotRef.current = null;
    setState({
      group: null,
      participants: EMPTY_PARTICIPANTS,
      history: EMPTY_HISTORY,
      spin: EMPTY_SPIN,
      viewer: null,
      dismissedSpinResult: null,
      isLoading: true,
      error: null,
      status: "connecting",
    });

    return () => {
      connection.close();
      connectionRef.current = null;
      snapshotRef.current = null;
    };
  }, [getToken, groupId]);

  const request = useCallback(
    async (command: Parameters<ReturnType<typeof connectGroupRealtime>["request"]>[0]) => {
      const connection = connectionRef.current;
      if (!connection) {
        throw new Error("Realtime connection unavailable.");
      }

      await connection.request(command);
    },
    [],
  );

  return useMemo(
    () => ({
      ...state,
      request,
    }),
    [request, state],
  );
}
const EMPTY_SPIN: GroupSpinState = {
  status: "idle",
  spinId: null,
  startedAt: null,
  resolvedAt: null,
  winnerParticipantId: null,
  targetAngle: null,
  durationMs: null,
  extraTurns: null,
};
