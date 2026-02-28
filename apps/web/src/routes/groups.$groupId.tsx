import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "../lib/audio";
import { ApiError, groupsApi, type Participant } from "../lib/groups";
import { clearLastGroupId, setLastGroupId } from "../lib/storage";
import {
  activeParticipants,
  pickSpinTarget,
  segmentColor,
  winnerIndexFromRotation,
} from "../lib/wheel";

export const Route = createFileRoute("/groups/$groupId")({
  component: GroupPage,
});

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
  const [isMuted, setIsMuted] = useState(audioEngine.isMuted());
  const timeoutRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      if (tickRef.current) {
        window.clearInterval(tickRef.current);
      }
    };
  }, []);

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

  const participants = useMemo(
    () => participantsQuery.data ?? [],
    [participantsQuery.data],
  );
  const eligibleParticipants = useMemo(() => activeParticipants(participants), [participants]);

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

  const addMutation = useMutation({
    mutationFn: (name: string) => groupsApi.addParticipant({ groupId, name }),
    onSuccess: async () => {
      setParticipantName("");
      setParticipantError(null);
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
    },
    onError: (error: Error) => {
      setParticipantError(error.message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (participantId: string) =>
      groupsApi.removeParticipant({ groupId, participantId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ participantId, active }: { participantId: string; active: boolean }) =>
      groupsApi.setParticipantActive({ groupId, participantId, active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (nextValue: boolean) =>
      groupsApi.updateGroupSettings({
        groupId,
        settings: { removeWinnerAfterSpin: nextValue },
      }),
    onSuccess: async (settings) => {
      setSettingsError(null);
      queryClient.setQueryData(
        ["groups", groupId],
        (current: Awaited<ReturnType<typeof groupsApi.getGroup>> | undefined) =>
          current ? { ...current, settings } : current,
      );
    },
    onError: (error: Error) => {
      setSettingsError(error.message);
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
    if (isSpinning || eligibleParticipants.length < 2) {
      return;
    }

    void audioEngine.playClick();
    setWinner(null);

    const { targetRotation, winnerIndex, durationMs } = pickSpinTarget(
      rotation,
      eligibleParticipants.length,
    );

    setIsSpinning(true);
    setSpinDurationMs(durationMs);
    setRotation(targetRotation);

    tickRef.current = window.setInterval(() => {
      void audioEngine.playTick();
    }, 140);

    timeoutRef.current = window.setTimeout(async () => {
      if (tickRef.current) {
        window.clearInterval(tickRef.current);
      }

      const confirmedIndex = winnerIndexFromRotation(
        targetRotation,
        eligibleParticipants.length,
      );
      const selected = eligibleParticipants[confirmedIndex >= 0 ? confirmedIndex : winnerIndex];

      setIsSpinning(false);
      setWinner(selected ?? null);
      void audioEngine.playWin();

      if (removeWinnerAfterSpin && selected) {
        await toggleActiveMutation.mutateAsync({
          participantId: selected.id,
          active: false,
        });
      }
    }, durationMs);
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
            <button
              type="submit"
              className="primary-btn"
              disabled={addMutation.isPending}
            >
              Add
            </button>
          </form>
          {participantError && <p className="error-text">{participantError}</p>}

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={removeWinnerAfterSpin}
              onChange={(event) => {
                const nextValue = event.target.checked;
                setRemoveWinnerAfterSpin(nextValue);
                setSettingsError(null);
                updateSettingsMutation.mutate(nextValue, {
                  onError: () => {
                    setRemoveWinnerAfterSpin(!nextValue);
                  },
                });
              }}
              disabled={updateSettingsMutation.isPending}
            />
            Remove winner after spin
          </label>
          {settingsError && <p className="error-text">{settingsError}</p>}

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
            disabled={isSpinning || eligibleParticipants.length < 2}
          >
            {isSpinning ? "Spinning..." : "Spin the Wheel"}
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
                disabled={isSpinning || eligibleParticipants.length < 2}
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
