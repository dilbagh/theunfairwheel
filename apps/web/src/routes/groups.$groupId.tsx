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
import { activeParticipants, rotationForWinner, segmentColor } from "../lib/wheel";

export const Route = createFileRoute("/groups/$groupId")({
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

function GroupPage() {
  const { groupId } = Route.useParams();
  const queryClient = useQueryClient();
  const [participantName, setParticipantName] = useState("");
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinDurationMs, setSpinDurationMs] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winner, setWinner] = useState<Participant | null>(null);
  const [removeWinnerAfterSpin, setRemoveWinnerAfterSpin] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
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

  const applyWinner = (winnerParticipantId: string | null) => {
    if (!winnerParticipantId) {
      setWinner(null);
      return;
    }

    const latestParticipants =
      queryClient.getQueryData<Participant[]>(["participants", groupId]) ?? [];
    const nextWinner = latestParticipants.find((participant) => participant.id === winnerParticipantId);
    setWinner(nextWinner ?? null);
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
    const winnerIndex = latestActive.findIndex(
      (participant) => participant.id === spin.winnerParticipantId,
    );

    if (winnerIndex < 0) {
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
      latestActive.length,
      winnerIndex,
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
      applyWinner(currentSpinWinnerIdRef.current);
      void audioEngine.playWin();
    }, spin.durationMs);
  };

  const applyRealtimeEvent = (event: GroupRealtimeEvent) => {
    if (event.type !== "snapshot" && event.version <= lastVersionRef.current) {
      return;
    }

    lastVersionRef.current = Math.max(lastVersionRef.current, event.version);

    switch (event.type) {
      case "snapshot": {
        queryClient.setQueryData<GroupData>(["groups", groupId], event.payload.group);
        queryClient.setQueryData<Participant[]>(["participants", groupId], event.payload.participants);
        setRemoveWinnerAfterSpin(event.payload.group.settings.removeWinnerAfterSpin);

        if (
          event.payload.spin.status === "spinning" &&
          event.payload.spin.spinId &&
          event.payload.spin.spinId !== currentSpinIdRef.current
        ) {
          runSpinAnimation(event.payload.spin);
        }

        break;
      }

      case "group.settings.updated": {
        setRemoveWinnerAfterSpin(event.payload.settings.removeWinnerAfterSpin);
        queryClient.setQueryData<GroupData>(["groups", groupId], (current) =>
          current
            ? {
                ...current,
                settings: event.payload.settings,
              }
            : current,
        );
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
          applyWinner(event.payload.spin.winnerParticipantId);
        }
        setIsSpinRequestPending(false);
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
    if (groupQuery.data?.settings) {
      setRemoveWinnerAfterSpin(groupQuery.data.settings.removeWinnerAfterSpin);
    }
  }, [groupQuery.data]);

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

  const toggleActiveMutation = useMutation<
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

  const updateSettingsMutation = useMutation<
    Awaited<ReturnType<typeof groupsApi.updateGroupSettings>>,
    Error,
    boolean,
    { previousGroup: GroupData | undefined }
  >({
    mutationFn: (nextValue: boolean) =>
      groupsApi.updateGroupSettings({
        groupId,
        settings: { removeWinnerAfterSpin: nextValue },
      }),
    onMutate: async (nextValue) => {
      await queryClient.cancelQueries({ queryKey: ["groups", groupId] });
      const previousGroup = queryClient.getQueryData<GroupData>(["groups", groupId]);

      queryClient.setQueryData<GroupData>(["groups", groupId], (current) =>
        current
          ? {
              ...current,
              settings: {
                ...current.settings,
                removeWinnerAfterSpin: nextValue,
              },
            }
          : current,
      );

      setRemoveWinnerAfterSpin(nextValue);
      setSettingsError(null);

      return { previousGroup };
    },
    onError: (error, _nextValue, context) => {
      if (context) {
        queryClient.setQueryData<GroupData>(["groups", groupId], context.previousGroup);
        setRemoveWinnerAfterSpin(
          context.previousGroup?.settings.removeWinnerAfterSpin ?? removeWinnerAfterSpin,
        );
      }
      setSettingsError(error.message);
    },
    onSuccess: (settings) => {
      setSettingsError(null);
      queryClient.setQueryData<GroupData>(["groups", groupId], (current) =>
        current
          ? {
              ...current,
              settings,
            }
          : current,
      );
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

  const wheelCount = Math.max(eligibleParticipants.length, 1);
  const degrees = 360 / wheelCount;

  return (
    <section className="game-layout reveal-up">
      <header className="panel header-panel">
        <div>
          <p className="eyebrow">Group Lobby</p>
          <h1>{group.name}</h1>
          <p className="muted-text">ID: {group.id}</p>
          <p className="muted-text">Realtime: {realtimeStatus}</p>
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            void audioEngine.playClick();
            const nextMuted = !isMuted;
            audioEngine.setMuted(nextMuted);
            setIsMuted(nextMuted);
          }}
        >
          {isMuted ? "Unmute" : "Mute"} sound
        </button>
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
            <button type="submit" className="primary-btn" disabled={addMutation.isPending}>
              Add
            </button>
          </form>
          {participantError && <p className="error-text">{participantError}</p>}

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={removeWinnerAfterSpin}
              onChange={(event) => {
                updateSettingsMutation.mutate(event.target.checked);
              }}
              disabled={updateSettingsMutation.isPending}
            />
            Remove winner after spin
          </label>
          {settingsError && <p className="error-text">{settingsError}</p>}
          {spinError && <p className="error-text">{spinError}</p>}

          <ul className="participant-list">
            {participants.length === 0 && <li className="muted-text">No participants yet.</li>}
            {participants.map((participant) => (
              <li key={participant.id} className="participant-item">
                <button
                  type="button"
                  className={`status-dot ${participant.active ? "active" : "inactive"}`}
                  onClick={() =>
                    toggleActiveMutation.mutate({
                      participantId: participant.id,
                      active: !participant.active,
                    })
                  }
                  aria-label={participant.active ? "Deactivate participant" : "Activate participant"}
                />
                <span className={participant.active ? "" : "inactive-name"}>{participant.name}</span>
                <button
                  type="button"
                  className="danger-btn"
                  onClick={() => removeMutation.mutate(participant.id)}
                >
                  Remove
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
                  const start = index * degrees;
                  const end = start + degrees;
                  const largeArc = degrees > 180 ? 1 : 0;
                  const sx = Math.cos((Math.PI / 180) * start) * 190;
                  const sy = Math.sin((Math.PI / 180) * start) * 190;
                  const ex = Math.cos((Math.PI / 180) * end) * 190;
                  const ey = Math.sin((Math.PI / 180) * end) * 190;
                  const path = `M 0 0 L ${sx} ${sy} A 190 190 0 ${largeArc} 1 ${ex} ${ey} Z`;
                  const labelAngle = start + degrees / 2;
                  const tx = Math.cos((Math.PI / 180) * labelAngle) * 120;
                  const ty = Math.sin((Math.PI / 180) * labelAngle) * 120;

                  return (
                    <g key={participant.id}>
                      <path d={path} fill={segmentColor(index)} opacity={0.86} />
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
              <button type="button" className="ghost-btn" onClick={() => setWinner(null)}>
                Close
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  setWinner(null);
                  onSpin();
                }}
                disabled={isSpinning || isSpinRequestPending || eligibleParticipants.length < 2}
              >
                Spin Again
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
