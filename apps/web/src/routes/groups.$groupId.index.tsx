import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "../lib/audio";
import { connectGroupRealtime, type GroupRealtimeStatus } from "../lib/group-realtime";
import {
  ApiError,
  groupsApi,
  type GroupRealtimeEvent,
  type GroupSpinState,
  type Participant,
} from "../lib/groups";
import { clearLastGroupId, setLastGroupId } from "../lib/storage";
import { activeParticipants, rotationForWinner, segmentColor, weightedSegments } from "../lib/wheel";

export const Route = createFileRoute("/groups/$groupId/")({
  component: GroupPage,
});

type GroupData = Awaited<ReturnType<typeof groupsApi.getGroup>>;

type ParticipantMutationContext = {
  previousParticipants: Participant[];
};

type AddParticipantMutationContext = ParticipantMutationContext & {
  optimisticId: string;
};

function normalizeParticipantName(name: string): string {
  return name.trim().toLowerCase();
}

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

function IconVolumeOn() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 9v6h4l5 4V5L7 9H3Zm13.5 3a3.5 3.5 0 0 0-1.8-3.07v6.14A3.5 3.5 0 0 0 16.5 12Zm-1.8-8.34v2.06a7 7 0 0 1 0 12.56v2.06a9 9 0 0 0 0-16.68Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconVolumeOff() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 9v6h4l5 4V5L7 9H3Zm16.1-.1-1.4-1.4L15 10.2l-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7 2.7-2.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9.2 16.2 5.5 12.5l1.4-1.4 2.3 2.3 7-7 1.4 1.4-8.4 8.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconUserX() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.3 0-6 1.35-6 3v1h9.6a5.6 5.6 0 0 1-.6-2.5c0-.52.07-1.03.2-1.5Zm7.8 7.2-1.6 1.6-1.7-1.7-1.7 1.7-1.6-1.6 1.7-1.7-1.7-1.7 1.6-1.6 1.7 1.7 1.7-1.7 1.6 1.6-1.7 1.7 1.7 1.7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-5-11h10v2H7v-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" fill="currentColor" />
    </svg>
  );
}

function GroupPage() {
  const { groupId } = Route.useParams();
  const queryClient = useQueryClient();
  const [participantName, setParticipantName] = useState("");
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinDurationMs, setSpinDurationMs] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winner, setWinner] = useState<Participant | null>(null);
  const [winnerSpinId, setWinnerSpinId] = useState<string | null>(null);
  const [spinError, setSpinError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(audioEngine.isMuted());
  const [realtimeStatus, setRealtimeStatus] = useState<GroupRealtimeStatus>("connecting");
  const [isSpinRequestPending, setIsSpinRequestPending] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const currentSpinIdRef = useRef<string | null>(null);
  const currentSpinWinnerIdRef = useRef<string | null>(null);
  const lastVersionRef = useRef(0);
  const applyRealtimeEventRef = useRef<(event: GroupRealtimeEvent) => void>(() => {});

  const groupQuery = useQuery({
    queryKey: ["groups", groupId],
    queryFn: () => groupsApi.getGroup({ id: groupId }),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) {
        return false;
      }

      return failureCount < 3;
    },
  });

  const participantsQuery = useQuery({
    queryKey: ["participants", groupId],
    queryFn: () => groupsApi.listParticipants({ groupId }),
  });

  const participants = useMemo(() => participantsQuery.data ?? [], [participantsQuery.data]);
  const eligibleParticipants = useMemo(() => activeParticipants(participants), [participants]);
  const wheelSegments = useMemo(
    () => weightedSegments(eligibleParticipants),
    [eligibleParticipants],
  );

  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);

  const clearSpinTimers = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const applyWinner = (winnerParticipantId: string | null, spinId: string | null) => {
    if (!winnerParticipantId) {
      setWinner(null);
      setWinnerSpinId(null);
      return;
    }

    const latestParticipants =
      queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];
    const nextWinner = latestParticipants.find((participant) => participant.id === winnerParticipantId);
    setWinner(nextWinner ?? null);
    setWinnerSpinId(spinId);
  };

  const runSpinAnimation = (spin: GroupSpinState) => {
    if (
      spin.status !== "spinning" ||
      !spin.winnerParticipantId ||
      typeof spin.durationMs !== "number" ||
      typeof spin.extraTurns !== "number"
    ) {
      return;
    }

    const latestParticipants =
      queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];
    const latestActive = activeParticipants(latestParticipants);
    const segments = weightedSegments(latestActive);
    if (!segments.some((segment) => segment.participantId === spin.winnerParticipantId)) {
      return;
    }

    clearSpinTimers();

    currentSpinIdRef.current = spin.spinId;
    currentSpinWinnerIdRef.current = spin.winnerParticipantId;
    setIsSpinRequestPending(false);
    setSpinError(null);
    setWinner(null);

    const targetRotation = rotationForWinner(
      rotationRef.current,
      segments,
      spin.winnerParticipantId,
      spin.extraTurns,
    );

    setIsSpinning(true);
    setSpinDurationMs(spin.durationMs);
    setRotation(targetRotation);

    tickRef.current = window.setInterval(() => {
      void audioEngine.playTick();
    }, 140);

    timeoutRef.current = window.setTimeout(() => {
      clearSpinTimers();
      setIsSpinning(false);
      applyWinner(currentSpinWinnerIdRef.current, currentSpinIdRef.current);
      void audioEngine.playWin();
    }, spin.durationMs);
  };

  const applyRealtimeEvent = (event: GroupRealtimeEvent) => {
    if (event.type !== "snapshot" && event.version < lastVersionRef.current) {
      return;
    }

    lastVersionRef.current = Math.max(lastVersionRef.current, event.version);

    switch (event.type) {
      case "snapshot": {
        queryClient.setQueryData<GroupData>(["groups", groupId], event.payload.group);
        queryClient.setQueryData<Participant[]>(["participants", groupId], event.payload.participants);

        if (
          event.payload.spin.status === "spinning" &&
          event.payload.spin.spinId &&
          event.payload.spin.spinId !== currentSpinIdRef.current
        ) {
          runSpinAnimation(event.payload.spin);
        }

        break;
      }

      case "participant.added": {
        queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) => {
          if (current.some((participant) => participant.id === event.payload.participant.id)) {
            return current;
          }

          const optimisticIndex = current.findIndex(
            (participant) =>
              participant.id.startsWith("optimistic-") &&
              normalizeParticipantName(participant.name) ===
                normalizeParticipantName(event.payload.participant.name),
          );

          if (optimisticIndex >= 0) {
            const next = [...current];
            next[optimisticIndex] = event.payload.participant;
            return dedupeParticipantsById(next);
          }

          return dedupeParticipantsById([...current, event.payload.participant]);
        });
        break;
      }

      case "participant.updated": {
        queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
          current.map((participant) =>
            participant.id === event.payload.participant.id
              ? event.payload.participant
              : participant,
          ),
        );
        break;
      }

      case "participant.removed": {
        queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
          current.filter((participant) => participant.id !== event.payload.participantId),
        );

        if (winner?.id === event.payload.participantId) {
          setWinner(null);
        }
        break;
      }

      case "spin.started": {
        if (event.payload.spin.spinId === currentSpinIdRef.current && isSpinning) {
          break;
        }

        runSpinAnimation(event.payload.spin);
        break;
      }

      case "spin.resolved": {
        currentSpinWinnerIdRef.current = event.payload.spin.winnerParticipantId;
        currentSpinIdRef.current = event.payload.spin.spinId;
        if (!isSpinning) {
          applyWinner(event.payload.spin.winnerParticipantId, event.payload.spin.spinId);
        }
        setIsSpinRequestPending(false);
        break;
      }

      case "spin.result.dismissed": {
        if (winnerSpinId === event.payload.spinId) {
          setWinner(null);
          setWinnerSpinId(null);
        }
        setSpinError(null);
        if (event.payload.action === "discard") {
          void queryClient.invalidateQueries({ queryKey: ["spin-history", groupId] });
        }
        break;
      }

      default:
        break;
    }
  };

  applyRealtimeEventRef.current = applyRealtimeEvent;

  useEffect(() => {
    const connection = connectGroupRealtime({
      groupId,
      onEvent: (event) => applyRealtimeEventRef.current(event),
      onStatusChange: setRealtimeStatus,
    });

    return () => {
      connection.close();
    };
  }, [groupId]);

  useEffect(() => {
    return () => {
      clearSpinTimers();
    };
  }, []);

  useEffect(() => {
    if (groupQuery.data?.id) {
      setLastGroupId(groupQuery.data.id);
    }
  }, [groupQuery.data]);

  const addMutation = useMutation<Participant, Error, string, AddParticipantMutationContext>({
    mutationFn: (name: string) => groupsApi.addParticipant({ groupId, name }),
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: ["participants", groupId] });
      const previousParticipants =
        queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];

      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      const optimisticParticipant: Participant = {
        id: optimisticId,
        name,
        active: true,
        spinsSinceLastWon: 0,
      };

      queryClient.setQueryData<Participant[]>(["participants", groupId], [
        ...previousParticipants,
        optimisticParticipant,
      ]);

      setParticipantError(null);
      setParticipantName("");

      return { previousParticipants, optimisticId };
    },
    onError: (error, _variables, context) => {
      if (context) {
        queryClient.setQueryData<Participant[]>(
          ["participants", groupId],
          context.previousParticipants,
        );
      }
      setParticipantError(error.message);
    },
    onSuccess: (participant, _name, context) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
        dedupeParticipantsById(
          current.map((item) => (item.id === context.optimisticId ? participant : item)),
        ),
      );
    },
  });

  const removeMutation = useMutation<void, Error, string, ParticipantMutationContext>({
    mutationFn: (participantId: string) => groupsApi.removeParticipant({ groupId, participantId }),
    onMutate: async (participantId) => {
      await queryClient.cancelQueries({ queryKey: ["participants", groupId] });
      const previousParticipants =
        queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];

      queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
        current.filter((participant) => participant.id !== participantId),
      );

      return { previousParticipants };
    },
    onError: (_error, _variables, context) => {
      if (context) {
        queryClient.setQueryData<Participant[]>(
          ["participants", groupId],
          context.previousParticipants,
        );
      }
    },
  });

  const togglePresenceMutation = useMutation<
    Participant,
    Error,
    { participantId: string; active: boolean },
    ParticipantMutationContext
  >({
    mutationFn: ({ participantId, active }) =>
      groupsApi.setParticipantActive({ groupId, participantId, active }),
    onMutate: async ({ participantId, active }) => {
      await queryClient.cancelQueries({ queryKey: ["participants", groupId] });
      const previousParticipants =
        queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];

      queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
        current.map((participant) =>
          participant.id === participantId ? { ...participant, active } : participant,
        ),
      );

      return { previousParticipants };
    },
    onError: (_error, _variables, context) => {
      if (context) {
        queryClient.setQueryData<Participant[]>(
          ["participants", groupId],
          context.previousParticipants,
        );
      }
    },
  });

  const spinMutation = useMutation({
    mutationFn: () => groupsApi.requestSpin({ groupId }),
    onMutate: () => {
      setSpinError(null);
      setIsSpinRequestPending(true);
    },
    onError: (error: Error) => {
      setIsSpinRequestPending(false);
      setSpinError(error.message);
    },
  });

  const discardSpinHistoryMutation = useMutation({
    mutationFn: (spinId: string) => groupsApi.discardSpinHistoryItem({ groupId, spinId }),
    onError: (error: Error) => {
      setSpinError(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
      await queryClient.invalidateQueries({ queryKey: ["spin-history", groupId] });
    },
  });

  const saveSpinHistoryMutation = useMutation({
    mutationFn: (spinId: string) => groupsApi.saveSpinHistoryItem({ groupId, spinId }),
    onError: (error: Error) => {
      setSpinError(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
    },
  });

  const onAddParticipant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = participantName.trim();
    setParticipantError(null);

    if (!normalized) {
      setParticipantError("Participant name is required.");
      return;
    }

    void audioEngine.playClick();
    addMutation.mutate(normalized);
  };

  const onSpin = () => {
    if (isSpinning || isSpinRequestPending || eligibleParticipants.length < 2) {
      return;
    }

    setWinner(null);
    setWinnerSpinId(null);
    void audioEngine.playClick();
    spinMutation.mutate();
  };

  if (groupQuery.isLoading || participantsQuery.isLoading) {
    return <p className="status-text">Loading group...</p>;
  }

  if (groupQuery.isError) {
    return (
      <section className="center-panel">
        <h1>Group Not Found</h1>
        <p className="muted-text">This group id does not exist.</p>
        <Link
          className="primary-btn link-btn"
          to="/"
          onClick={() => {
            clearLastGroupId();
          }}
        >
          Create a new group
        </Link>
      </section>
    );
  }

  const group = groupQuery.data;
  if (!group) {
    return <p className="status-text">Group unavailable.</p>;
  }

  return (
    <section className="game-layout reveal-up">
      <header className="panel header-panel">
        <div>
          <p className="eyebrow">Group Lobby</p>
          <h1>{group.name}</h1>
          <p className="muted-text">ID: {group.id}</p>
          <p className="muted-text">Realtime: {realtimeStatus}</p>
        </div>
        <div className="header-actions">
          <Link className="ghost-btn header-history-link" to="/groups/$groupId/history" params={{ groupId }}>
            View History
          </Link>
          <Link
            className="ghost-btn header-history-link"
            to="/"
            onClick={() => {
              void audioEngine.playClick();
              clearLastGroupId();
            }}
          >
            Create new group
          </Link>
          <button
            type="button"
            className="ghost-btn icon-btn sound-btn"
            aria-label={isMuted ? "Unmute sound" : "Mute sound"}
            title={isMuted ? "Unmute sound" : "Mute sound"}
            onClick={() => {
              void audioEngine.playClick();
              const nextMuted = !isMuted;
              audioEngine.setMuted(nextMuted);
              setIsMuted(nextMuted);
            }}
          >
            {isMuted ? <IconVolumeOff /> : <IconVolumeOn />}
            <span className="sr-only">{isMuted ? "Unmute sound" : "Mute sound"}</span>
          </button>
        </div>
      </header>

      <div className="content-grid">
        <aside className="panel side-panel">
          <h2>Participants</h2>
          <form className="form-row" onSubmit={onAddParticipant}>
            <input
              className="text-input"
              value={participantName}
              onChange={(event) => setParticipantName(event.target.value)}
              placeholder="Add a name"
              maxLength={60}
            />
            <button
              type="submit"
              className="primary-btn icon-btn add-btn"
              disabled={addMutation.isPending}
              aria-label="Add participant"
              title="Add participant"
            >
              <IconPlus />
              <span className="sr-only">Add participant</span>
            </button>
          </form>
          {participantError && <p className="error-text">{participantError}</p>}
          <p className="muted-text">
            Inactive participants stay in the list but are excluded from the wheel.
          </p>
          {spinError && <p className="error-text">{spinError}</p>}

          <ul className="participant-list">
            {participants.length === 0 && <li className="muted-text">No participants yet.</li>}
            {participants.map((participant) => (
              <li key={participant.id} className="participant-item">
                <button
                  type="button"
                  className={`participant-toggle ${participant.active ? "present" : "absent"}`}
                  onClick={() =>
                    togglePresenceMutation.mutate({
                      participantId: participant.id,
                      active: !participant.active,
                    })
                  }
                  aria-label={
                    participant.active
                      ? "Mark participant absent and exclude from wheel"
                      : "Mark participant present and include in wheel"
                  }
                >
                  <span className="participant-toggle-icon">
                    {participant.active ? <IconCheck /> : <IconUserX />}
                  </span>
                  <span>{participant.active ? "Present" : "Absent"}</span>
                </button>
                <div className="participant-meta">
                  <span className={`participant-name ${participant.active ? "" : "inactive-name"}`}>
                    {participant.name}
                  </span>
                  <span className="participant-counter">
                    Spins since win: {participant.spinsSinceLastWon}
                  </span>
                </div>
                <button
                  type="button"
                  className="danger-btn icon-btn remove-btn"
                  aria-label={`Remove ${participant.name}`}
                  title={`Remove ${participant.name}`}
                  onClick={() => removeMutation.mutate(participant.id)}
                >
                  <IconTrash />
                  <span className="sr-only">Remove</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="panel wheel-panel">
          <div className="wheel-wrap">
            <div className="pointer" aria-hidden />
            <svg
              className="wheel"
              viewBox="0 0 400 400"
              style={{
                transform: `rotate(${rotation}deg)`,
                transitionDuration: `${spinDurationMs}ms`,
              }}
            >
              <g transform="translate(200 200)">
                {eligibleParticipants.length === 0 && (
                  <>
                    <circle r="190" fill="#0e1d32" stroke="#00e7ff" strokeWidth="3" />
                    <text textAnchor="middle" fill="#d2f6ff" fontSize="18" dy="8">
                      Add active names
                    </text>
                  </>
                )}
                {eligibleParticipants.map((participant, index) => {
                  const segment = wheelSegments[index];
                  if (!segment) {
                    return null;
                  }

                  const largeArc = segment.sweep > 180 ? 1 : 0;
                  const start = segment.startAngle;
                  const end = segment.endAngle;
                  const sx = Math.cos((Math.PI / 180) * start) * 190;
                  const sy = Math.sin((Math.PI / 180) * start) * 190;
                  const ex = Math.cos((Math.PI / 180) * end) * 190;
                  const ey = Math.sin((Math.PI / 180) * end) * 190;
                  const path = `M 0 0 L ${sx} ${sy} A 190 190 0 ${largeArc} 1 ${ex} ${ey} Z`;
                  const labelAngle = segment.midAngle;
                  const tx = Math.cos((Math.PI / 180) * labelAngle) * 120;
                  const ty = Math.sin((Math.PI / 180) * labelAngle) * 120;

                  return (
                    <g key={participant.id}>
                      <path
                        d={path}
                        fill={segmentColor(index)}
                        opacity={0.86}
                        stroke="#d9f3ff"
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                      <text
                        x={tx}
                        y={ty}
                        fill="#04101e"
                        fontSize="16"
                        fontWeight="700"
                        textAnchor="middle"
                        transform={`rotate(${labelAngle} ${tx} ${ty})`}
                      >
                        {participant.name.slice(0, 14)}
                      </text>
                    </g>
                  );
                })}
                {eligibleParticipants.length > 0 && (
                  <circle
                    r="190"
                    fill="none"
                    stroke="#d9f3ff"
                    strokeWidth="4"
                    pointerEvents="none"
                  />
                )}
                <circle r="24" fill="#f6c35b" />
              </g>
            </svg>
          </div>

          <button
            type="button"
            className="primary-btn spin-btn"
            onClick={onSpin}
            disabled={isSpinning || isSpinRequestPending || eligibleParticipants.length < 2}
          >
            {isSpinning || isSpinRequestPending ? "Spinning..." : "Spin the Wheel"}
          </button>
          {eligibleParticipants.length < 2 && (
            <p className="muted-text">Need at least 2 active participants to spin.</p>
          )}
        </div>
      </div>

      {winner && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="winner-heading">
            <p className="eyebrow winner-tag">Winner</p>
            <h2 id="winner-heading">{winner.name}</h2>
            <p className="muted-text">The wheel has chosen the next lucky champion.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  setSpinError(null);
                  if (!winnerSpinId) {
                    setWinner(null);
                    setWinnerSpinId(null);
                    return;
                  }

                  saveSpinHistoryMutation.mutate(winnerSpinId, {
                    onSuccess: () => {
                      setWinner(null);
                      setWinnerSpinId(null);
                    },
                  });
                }}
                autoFocus
                disabled={saveSpinHistoryMutation.isPending}
              >
                Save
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setSpinError(null);
                  if (!winnerSpinId) {
                    setWinner(null);
                    setWinnerSpinId(null);
                    return;
                  }

                  discardSpinHistoryMutation.mutate(winnerSpinId, {
                    onSuccess: () => {
                      setWinner(null);
                      setWinnerSpinId(null);
                    },
                  });
                }}
                disabled={
                  saveSpinHistoryMutation.isPending ||
                  discardSpinHistoryMutation.isPending ||
                  !winnerSpinId
                }
              >
                Discard
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setSpinError(null);
                  if (!winnerSpinId) {
                    setWinner(null);
                    setWinnerSpinId(null);
                    onSpin();
                    return;
                  }

                  discardSpinHistoryMutation.mutate(winnerSpinId, {
                    onSuccess: () => {
                      setWinner(null);
                      setWinnerSpinId(null);
                      onSpin();
                    },
                  });
                }}
                disabled={
                  saveSpinHistoryMutation.isPending ||
                  discardSpinHistoryMutation.isPending ||
                  isSpinning ||
                  isSpinRequestPending ||
                  eligibleParticipants.length < 2
                }
              >
                Respin
              </button>
            </div>
            {spinError && <p className="error-text">{spinError}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
