import { useAuth } from "@clerk/clerk-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Bookmark as IconBookmark,
  BookmarkCheck as IconBookmarkFilled,
  Check as IconCheck,
  Pencil as IconEdit,
  Share2 as IconShare,
  Trash2 as IconTrash,
  UserRoundX as IconUserX,
  Volume2 as IconVolumeOn,
  VolumeX as IconVolumeOff,
} from "lucide-react";
import { type CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconConnected,
  IconClose,
  IconDisconnected,
  IconHistory,
  IconNewGroup,
  IconRespin,
  IconSave,
  IconSpark,
  IconUsers,
} from "../components/button-icons";
import { audioEngine } from "../lib/audio";
import { deriveGroupPageAccess } from "../lib/group-page-access";
import { type GroupRealtimeStatus } from "../lib/group-realtime";
import { useGroupSession } from "../lib/group-session";
import {
  type GroupSpinState,
  useGroupsApi,
  type Participant,
} from "../lib/groups";
import { clearLastGroupId, setLastGroupId } from "../lib/storage";
import { activeParticipants, rotationForWinner, segmentColor, weightedSegments } from "../lib/wheel";

export const Route = createFileRoute("/groups/$groupId/")({
  component: GroupPageRoute,
});

type ParticipantDraft = {
  id: string;
  participantId: string | null;
  name: string;
  active: boolean;
  spinsSinceLastWon: number;
  emailId: string;
  manager: boolean;
};

type ConfettiPiece = {
  id: string;
  left: number;
  delayMs: number;
  durationMs: number;
  driftPx: number;
  rotateDeg: number;
  color: string;
  sizePx: number;
};

type ConfettiStyle = CSSProperties & Record<`--${string}`, string>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function isValidOptionalEmail(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || EMAIL_PATTERN.test(trimmed);
}

function participantToDraft(participant: Participant): ParticipantDraft {
  return {
    id: participant.id,
    participantId: participant.id,
    name: participant.name,
    active: participant.active,
    spinsSinceLastWon: participant.spinsSinceLastWon,
    emailId: participant.emailId ?? "",
    manager: participant.manager ?? false,
  };
}

function GroupPageRoute() {
  const { groupId } = Route.useParams();

  return <GroupPage key={groupId} />;
}

function GroupPage() {
  const { groupId } = Route.useParams();
  const groupsApi = useGroupsApi();
  const { isSignedIn } = useAuth();
  const groupSession = useGroupSession(groupId);
  const queryClient = useQueryClient();
  const [rotation, setRotation] = useState(0);
  const [spinDurationMs, setSpinDurationMs] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winner, setWinner] = useState<Participant | null>(null);
  const [winnerSpinId, setWinnerSpinId] = useState<string | null>(null);
  const [spinError, setSpinError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(audioEngine.isMuted());
  const [isSpinRequestPending, setIsSpinRequestPending] = useState(false);
  const [isParticipantModalOpen, setIsParticipantModalOpen] = useState(false);
  const [participantModalError, setParticipantModalError] = useState<string | null>(null);
  const [participantDrafts, setParticipantDrafts] = useState<ParticipantDraft[]>([]);
  const [newParticipantName, setNewParticipantName] = useState("");
  const [newParticipantEmailId, setNewParticipantEmailId] = useState("");
  const [newParticipantManager, setNewParticipantManager] = useState(false);
  const [newParticipantError, setNewParticipantError] = useState<string | null>(null);
  const [isShareCopied, setIsShareCopied] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [renameDraftName, setRenameDraftName] = useState("");
  const [winnerConfetti, setWinnerConfetti] = useState<ConfettiPiece[]>([]);

  const timeoutRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const shareFeedbackTimeoutRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const currentSpinIdRef = useRef<string | null>(null);
  const currentSpinWinnerIdRef = useRef<string | null>(null);
  const lastWinnerEffectKeyRef = useRef<string | null>(null);
  const hasHydratedSpinRef = useRef(false);
  const lastObservedSpinStatusRef = useRef<GroupSpinState["status"]>("idle");
  const lastObservedSpinIdRef = useRef<string | null>(null);
  const bookmarkedGroupIdsQuery = useQuery({
    queryKey: ["group-bookmarks"],
    queryFn: () => groupsApi.listBookmarkedGroupIds(),
    enabled: isSignedIn,
  });
  const updateBookmarkedGroupIdsMutation = useMutation({
    mutationFn: (groupIds: string[]) => groupsApi.setBookmarkedGroupIds({ groupIds }),
    onMutate: async (nextGroupIds) => {
      await queryClient.cancelQueries({ queryKey: ["group-bookmarks"] });
      const previousGroupIds = queryClient.getQueryData<string[]>(["group-bookmarks"]) ?? [];
      queryClient.setQueryData<string[]>(["group-bookmarks"], Array.from(new Set(nextGroupIds)));
      return { previousGroupIds };
    },
    onError: (_error, _groupIds, context) => {
      if (context) {
        queryClient.setQueryData<string[]>(["group-bookmarks"], context.previousGroupIds);
      }
    },
    onSuccess: (nextGroupIds) => {
      queryClient.setQueryData<string[]>(["group-bookmarks"], nextGroupIds);
    },
  });

  const group = groupSession.group;
  const participants = useMemo(() => groupSession.participants ?? [], [groupSession.participants]);
  const viewer = groupSession.viewer;
  const canManageParticipants = Boolean(viewer?.isManager);
  const { canTogglePresence, canSpin, canViewHistory } = deriveGroupPageAccess(viewer);
  const bookmarkedGroupIds = bookmarkedGroupIdsQuery.data ?? [];
  const isGroupBookmarked = bookmarkedGroupIds.includes(groupId);
  const eligibleParticipants = useMemo(() => activeParticipants(participants), [participants]);
  const realtimeStatus: GroupRealtimeStatus = groupSession.status;
  const isRealtimeConnected = realtimeStatus === "open";
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
      window.clearTimeout(tickRef.current);
      tickRef.current = null;
    }
  };

  const scheduleSpinTick = useCallback((spinStartedAtMs: number, spinDurationMs: number) => {
    const elapsedMs = performance.now() - spinStartedAtMs;
    const progress = Math.min(1, Math.max(0, elapsedMs / spinDurationMs));

    if (progress >= 1) {
      tickRef.current = null;
      return;
    }

    const minDelayMs = 70;
    const maxDelayMs = 280;
    const curve = progress ** 2.2;
    const delayMs = minDelayMs + (maxDelayMs - minDelayMs) * curve;

    tickRef.current = window.setTimeout(() => {
      void audioEngine.playTick();
      scheduleSpinTick(spinStartedAtMs, spinDurationMs);
    }, delayMs);
  }, []);

  const clearShareFeedbackTimer = () => {
    if (shareFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(shareFeedbackTimeoutRef.current);
      shareFeedbackTimeoutRef.current = null;
    }
  };

  const applyWinner = useCallback((winnerParticipantId: string | null, spinId: string | null) => {
    if (!winnerParticipantId) {
      setWinner(null);
      setWinnerSpinId(null);
      return;
    }

    const nextWinner = participants.find((participant) => participant.id === winnerParticipantId);
    setWinner(nextWinner ?? null);
    setWinnerSpinId(spinId);
  }, [participants]);

  const runSpinAnimation = useCallback((spin: GroupSpinState) => {
    if (
      spin.status !== "spinning" ||
      !spin.winnerParticipantId ||
      typeof spin.durationMs !== "number" ||
      typeof spin.extraTurns !== "number"
    ) {
      return;
    }

    const latestActive = activeParticipants(participants);
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
      spin.targetAngle,
      spin.extraTurns,
    );

    setIsSpinning(true);
    setSpinDurationMs(spin.durationMs);
    setRotation(targetRotation);

    const spinStartedAtMs = performance.now();
    void audioEngine.playTick();
    scheduleSpinTick(spinStartedAtMs, spin.durationMs);

    timeoutRef.current = window.setTimeout(() => {
      clearSpinTimers();
      setIsSpinning(false);
      applyWinner(currentSpinWinnerIdRef.current, currentSpinIdRef.current);
    }, spin.durationMs);
  }, [applyWinner, participants, scheduleSpinTick]);

  useEffect(() => {
    return () => {
      clearSpinTimers();
      clearShareFeedbackTimer();
    };
  }, []);

  useEffect(() => {
    if (!winner) {
      lastWinnerEffectKeyRef.current = null;
      setWinnerConfetti([]);
      return;
    }

    const effectKey = `${winner.id}:${winnerSpinId ?? "no-spin-id"}`;
    if (lastWinnerEffectKeyRef.current === effectKey) {
      return;
    }

    lastWinnerEffectKeyRef.current = effectKey;
    void audioEngine.playWin();

    const palette = ["#f6c35b", "#39e3ff", "#ff8fab", "#6df7a1", "#ffffff"];
    const pieces: ConfettiPiece[] = Array.from({ length: 42 }, (_value, index) => ({
      id: `${effectKey}-${index}`,
      left: Math.random() * 100,
      delayMs: Math.floor(Math.random() * 220),
      durationMs: 1400 + Math.floor(Math.random() * 850),
      driftPx: -48 + Math.floor(Math.random() * 96),
      rotateDeg: Math.floor(Math.random() * 720),
      color: palette[index % palette.length] ?? "#ffffff",
      sizePx: 6 + Math.floor(Math.random() * 8),
    }));

    setWinnerConfetti(pieces);
    const cleanupTimer = window.setTimeout(() => {
      setWinnerConfetti([]);
    }, 2600);

    return () => {
      window.clearTimeout(cleanupTimer);
    };
  }, [winner, winnerSpinId]);

  useEffect(() => {
    if (group?.id) {
      setLastGroupId(group.id);
    }
  }, [group]);

  useEffect(() => {
    const spin = groupSession.spin;

    if (!hasHydratedSpinRef.current) {
      hasHydratedSpinRef.current = true;
      lastObservedSpinStatusRef.current = spin.status;
      lastObservedSpinIdRef.current = spin.spinId;
      currentSpinWinnerIdRef.current = spin.winnerParticipantId;
      currentSpinIdRef.current = spin.spinId;

      if (spin.status === "spinning" && spin.spinId) {
        runSpinAnimation(spin);
      }
      return;
    }

    if (
      spin.status === "spinning" &&
      spin.spinId &&
      spin.spinId !== currentSpinIdRef.current
    ) {
      lastObservedSpinStatusRef.current = spin.status;
      lastObservedSpinIdRef.current = spin.spinId;
      runSpinAnimation(spin);
      return;
    }

    currentSpinWinnerIdRef.current = spin.winnerParticipantId;
    currentSpinIdRef.current = spin.spinId;

    const resolvedDuringLiveSession =
      spin.status === "idle" &&
      spin.spinId &&
      !isSpinning &&
      lastObservedSpinStatusRef.current === "spinning" &&
      lastObservedSpinIdRef.current === spin.spinId;

    if (resolvedDuringLiveSession) {
      applyWinner(spin.winnerParticipantId, spin.spinId);
      setIsSpinRequestPending(false);
    }

    lastObservedSpinStatusRef.current = spin.status;
    lastObservedSpinIdRef.current = spin.spinId;
  }, [applyWinner, groupSession.spin, isSpinning, participants, runSpinAnimation]);

  useEffect(() => {
    if (winner && !participants.some((participant) => participant.id === winner.id)) {
      setWinner(null);
      setWinnerSpinId(null);
    }
  }, [participants, winner]);

  useEffect(() => {
    if (!groupSession.dismissedSpinResult) {
      return;
    }

    if (winnerSpinId === groupSession.dismissedSpinResult.spinId) {
      setWinner(null);
      setWinnerSpinId(null);
      setSpinError(null);
      setIsSpinRequestPending(false);
    }
  }, [groupSession.dismissedSpinResult, winnerSpinId]);

  const togglePresenceMutation = useMutation<void, Error, { participantId: string; active: boolean }>({
    mutationFn: ({ participantId, active }) =>
      groupSession.request({
        type: "participant.setActive",
        payload: { participantId, active },
      }),
    onError: (error: Error) => {
      setSpinError(error.message);
    },
  });

  const commitParticipantsMutation = useMutation({
    mutationFn: (input: {
      adds: Array<{ name: string; emailId: string | null; manager: boolean }>;
      updates: Array<{ participantId: string; emailId: string | null; manager: boolean }>;
      removes: string[];
    }) =>
      groupSession.request({
        type: "participants.commit",
        payload: input,
      }),
    onError: (error: Error) => {
      setParticipantModalError(error.message);
    },
    onSuccess: async () => {
      setParticipantModalError(null);
      setNewParticipantError(null);
      setIsParticipantModalOpen(false);
    },
  });

  const spinMutation = useMutation({
    mutationFn: () =>
      groupSession.request({
        type: "spin.start",
        payload: {},
      }),
    onMutate: () => {
      setSpinError(null);
      setIsSpinRequestPending(true);
    },
    onError: (error: Error) => {
      setIsSpinRequestPending(false);
      setSpinError(error.message);
    },
  });

  const renameGroupMutation = useMutation({
    mutationFn: (name: string) =>
      groupSession.request({
        type: "group.rename",
        payload: { name },
      }),
    onError: (error: Error) => {
      setRenameError(error.message);
    },
    onSuccess: () => {
      setRenameError(null);
      setIsRenameModalOpen(false);
    },
  });

  const discardSpinHistoryMutation = useMutation({
    mutationFn: (spinId: string) =>
      groupSession.request({
        type: "history.discard",
        payload: { spinId },
      }),
    onError: (error: Error) => {
      setSpinError(error.message);
    },
  });

  const saveSpinHistoryMutation = useMutation({
    mutationFn: (spinId: string) =>
      groupSession.request({
        type: "history.save",
        payload: { spinId },
      }),
    onError: (error: Error) => {
      setSpinError(error.message);
    },
  });

  const openParticipantModal = () => {
    if (!canManageParticipants) {
      setParticipantModalError("Manager access is required to manage participants.");
      return;
    }
    setParticipantDrafts(participants.map(participantToDraft));
    setParticipantModalError(null);
    setNewParticipantError(null);
    setNewParticipantName("");
    setNewParticipantEmailId("");
    setNewParticipantManager(false);
    setIsParticipantModalOpen(true);
  };

  const onAddDraftParticipant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = newParticipantName.trim();
    const normalizedEmail = normalizeEmailInput(newParticipantEmailId);
    const hasEmailInput = !!newParticipantEmailId.trim();

    setNewParticipantError(null);
    setParticipantModalError(null);

    if (!name || name.length > 60) {
      setNewParticipantError("Name must be between 1 and 60 characters.");
      return;
    }

    const duplicateName = participantDrafts.some(
      (participant) => participant.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicateName) {
      setNewParticipantError("Participant with this name already exists.");
      return;
    }

    if (hasEmailInput && !normalizedEmail) {
      setNewParticipantError("Email must be a valid email address.");
      return;
    }

    if (newParticipantManager && !normalizedEmail) {
      setNewParticipantError("Manager requires a valid email.");
      return;
    }

    setParticipantDrafts((current) => [
      ...current,
      {
        id: `new-${crypto.randomUUID()}`,
        participantId: null,
        name,
        active: true,
        spinsSinceLastWon: 0,
        emailId: normalizedEmail ?? "",
        manager: newParticipantManager,
      },
    ]);

    setNewParticipantName("");
    setNewParticipantEmailId("");
    setNewParticipantManager(false);
  };

  const hasDraftValidationError = useMemo(
    () => participantDrafts.some((participant) => !isValidOptionalEmail(participant.emailId)),
    [participantDrafts],
  );

  const hasDraftChanges = useMemo(() => {
    if (participantDrafts.length !== participants.length) {
      return true;
    }

    const participantsById = new Map(participants.map((participant) => [participant.id, participant]));

    for (const draft of participantDrafts) {
      if (!draft.participantId) {
        return true;
      }

      const current = participantsById.get(draft.participantId);
      if (!current) {
        return true;
      }

      const draftEmail = normalizeEmailInput(draft.emailId);
      const draftManager = draftEmail ? draft.manager : false;

      if ((current.emailId ?? null) !== draftEmail || (current.manager ?? false) !== draftManager) {
        return true;
      }
    }

    return false;
  }, [participantDrafts, participants]);

  const onConfirmParticipantModal = () => {
    setParticipantModalError(null);

    if (hasDraftValidationError) {
      setParticipantModalError("Fix invalid email fields before confirming.");
      return;
    }

    const currentById = new Map(participants.map((participant) => [participant.id, participant]));
    const draftByParticipantId = new Map(
      participantDrafts
        .filter((participant): participant is ParticipantDraft & { participantId: string } =>
          Boolean(participant.participantId),
        )
        .map((participant) => [participant.participantId, participant]),
    );

    const adds: Array<{ name: string; emailId: string | null; manager: boolean }> = [];
    const updates: Array<{ participantId: string; emailId: string | null; manager: boolean }> = [];
    const removes: string[] = [];

    for (const participant of participants) {
      const draft = draftByParticipantId.get(participant.id);
      if (!draft) {
        removes.push(participant.id);
        continue;
      }

      const emailId = normalizeEmailInput(draft.emailId);
      const manager = emailId ? draft.manager : false;
      if ((participant.emailId ?? null) !== emailId || (participant.manager ?? false) !== manager) {
        updates.push({ participantId: participant.id, emailId, manager });
      }
    }

    for (const draft of participantDrafts) {
      if (draft.participantId) {
        continue;
      }

      const emailId = normalizeEmailInput(draft.emailId);
      const manager = emailId ? draft.manager : false;
      adds.push({ name: draft.name, emailId, manager });
    }

    if (!adds.length && !updates.length && !removes.length) {
      setParticipantModalError("No participant changes to apply.");
      return;
    }

    const hasRemovedButReusedIds = removes.some((participantId) => !currentById.has(participantId));
    if (hasRemovedButReusedIds) {
      setParticipantModalError("Participant list changed. Reopen the modal and try again.");
      return;
    }

    void audioEngine.playClick();
    commitParticipantsMutation.mutate({ adds, updates, removes });
  };

  const onSpin = () => {
    if (!canSpin) {
      setSpinError("Only participants in this group can spin the wheel.");
      return;
    }

    if (isSpinning || isSpinRequestPending || eligibleParticipants.length < 2) {
      return;
    }

    setWinner(null);
    setWinnerSpinId(null);
    void audioEngine.playClick();
    spinMutation.mutate();
  };

  if (groupSession.isLoading) {
    return <p className="status-text">Loading group...</p>;
  }

  if (groupSession.error && !groupSession.group) {
    return (
      <section className="center-panel">
        <h1>Group Unavailable</h1>
        <p className="muted-text">{groupSession.error.message || "This group could not be loaded."}</p>
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

  if (!group) {
    return <p className="status-text">Group unavailable.</p>;
  }

  const isGroupOwner = Boolean(viewer?.isOwner);
  const canBookmarkGroup = isSignedIn && !isGroupOwner;
  const bookmarkTitle = isGroupBookmarked ? "Remove bookmark" : "Bookmark group";

  const onCopyGroupLink = async () => {
    void audioEngine.playClick();
    try {
      await navigator.clipboard.writeText(window.location.href);
      setIsShareCopied(true);
      clearShareFeedbackTimer();
      shareFeedbackTimeoutRef.current = window.setTimeout(() => {
        setIsShareCopied(false);
        shareFeedbackTimeoutRef.current = null;
      }, 1600);
    } catch {
      setIsShareCopied(false);
      // Ignore clipboard errors when unavailable in the current browser context.
    }
  };

  const openRenameModal = () => {
    if (!canManageParticipants) {
      setRenameError("Manager access is required to rename the group.");
      return;
    }
    void audioEngine.playClick();
    setRenameDraftName(group.name);
    setRenameError(null);
    setIsRenameModalOpen(true);
  };

  const onConfirmRenameGroup = () => {
    const normalized = renameDraftName.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > 60) {
      setRenameError("Name must be between 1 and 60 characters.");
      return;
    }

    if (normalized === group.name) {
      setRenameError(null);
      return;
    }

    setRenameError(null);
    renameGroupMutation.mutate(normalized);
  };

  const canSaveOrDiscardWinner = canSpin && Boolean(winnerSpinId);
  const canRespinWinner =
    canSpin &&
    !isSpinning &&
    !isSpinRequestPending &&
    eligibleParticipants.length >= 2 &&
    (Boolean(winnerSpinId) || !discardSpinHistoryMutation.isPending);

  return (
    <section className="game-layout reveal-up">
      <header className="panel header-panel">
        <div className="header-title-block">
          <p className="eyebrow">Group Lobby</p>
          <div className="group-title-row">
            <h1>{group.name}</h1>
            <button
              type="button"
              className="ghost-btn icon-btn title-rename-btn"
              aria-label={
                renameGroupMutation.isPending ? "Renaming current group" : "Rename current group"
              }
              title={renameGroupMutation.isPending ? "Renaming current group" : "Rename current group"}
              onClick={openRenameModal}
              disabled={!canManageParticipants || renameGroupMutation.isPending}
            >
              <IconEdit />
              <span className="sr-only">Rename group</span>
            </button>
            {canBookmarkGroup && (
              <button
                type="button"
                className={`ghost-btn icon-btn title-bookmark-btn ${
                  isGroupBookmarked ? "title-bookmark-btn-active" : ""
                }`}
                aria-label={bookmarkTitle}
                title={bookmarkTitle}
                onClick={() => {
                  if (!canBookmarkGroup || updateBookmarkedGroupIdsMutation.isPending) {
                    return;
                  }

                  void audioEngine.playClick();
                  const nextBookmarkedGroupIds = isGroupBookmarked
                    ? bookmarkedGroupIds.filter((bookmarkedGroupId) => bookmarkedGroupId !== groupId)
                    : [...bookmarkedGroupIds, groupId];

                  updateBookmarkedGroupIdsMutation.mutate(nextBookmarkedGroupIds);
                }}
                disabled={updateBookmarkedGroupIdsMutation.isPending}
              >
                {isGroupBookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
                <span className="sr-only">{bookmarkTitle}</span>
              </button>
            )}
            <button
              type="button"
              className={`ghost-btn icon-btn title-share-btn ${isShareCopied ? "title-share-btn-copied" : ""}`}
              aria-label={isShareCopied ? "Current group URL copied" : "Copy current group URL"}
              title={
                isShareCopied
                  ? "Current group URL copied"
                  : "Copies the URL of the current group"
              }
              onClick={() => {
                void onCopyGroupLink();
              }}
            >
              {isShareCopied ? <IconCheck /> : <IconShare />}
              <span className="sr-only">{isShareCopied ? "Group link copied" : "Copy group link"}</span>
            </button>
            {isShareCopied && (
              <span className="copy-feedback" role="status" aria-live="polite">
                Copied
              </span>
            )}
          </div>
          <span
            className={`connection-status ${
              isRealtimeConnected ? "connection-status-connected" : "connection-status-disconnected"
            }`}
            role="status"
            aria-live="polite"
            aria-label={isRealtimeConnected ? "Connected" : "Disconnected"}
            title={isRealtimeConnected ? "Connected" : "Disconnected"}
          >
            {isRealtimeConnected ? <IconConnected aria-hidden="true" /> : <IconDisconnected aria-hidden="true" />}
            <span className="sr-only">{isRealtimeConnected ? "Connected" : "Disconnected"}</span>
          </span>
        </div>
        <div className="header-actions">
          <Link
            className="ghost-btn header-history-link"
            to="/"
            onClick={() => {
              void audioEngine.playClick();
              clearLastGroupId();
            }}
          >
            <span className="btn-content">
              <IconNewGroup />
              <span className="btn-label">New Group</span>
            </span>
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
          <div className="participant-panel-header">
            <h2>Participants</h2>
            {canManageParticipants && (
              <button
                type="button"
                className="ghost-btn manage-participants-btn"
                onClick={() => {
                  void audioEngine.playClick();
                  openParticipantModal();
                }}
              >
                <span className="btn-content">
                  <IconUsers />
                  <span className="btn-label">Manage</span>
                </span>
              </button>
            )}
          </div>
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
                  disabled={!canTogglePresence}
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
              </li>
            ))}
          </ul>
          {canViewHistory ? (
            <Link
              className="ghost-btn participant-history-link"
              to="/groups/$groupId/history"
              params={{ groupId }}
            >
              <span className="btn-content">
                <IconHistory />
                <span className="btn-label">View History</span>
              </span>
            </Link>
          ) : (
            <button type="button" className="ghost-btn participant-history-link" disabled>
              <span className="btn-content">
                <IconHistory />
                <span className="btn-label">View History</span>
              </span>
            </button>
          )}
          {!isSignedIn && <p className="muted-text">Log in to manage participants.</p>}
          {isSignedIn && !canTogglePresence && (
            <p className="muted-text">You are not a participant in this group.</p>
          )}
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
                {eligibleParticipants.length > 0 && <circle r="24" fill="#f6c35b" />}
              </g>
            </svg>
          </div>

          <button
            type="button"
            className="primary-btn spin-btn"
            onClick={onSpin}
            disabled={!canSpin || isSpinning || isSpinRequestPending || eligibleParticipants.length < 2}
          >
            <span className="btn-content">
              <IconSpark />
              <span className="btn-label">
                {isSpinning || isSpinRequestPending ? "Spinning..." : "Spin the Wheel"}
              </span>
            </span>
          </button>
          {!canSpin && (
            <p className="muted-text">Only group participants can spin the wheel.</p>
          )}
          {canSpin && eligibleParticipants.length < 2 && (
            <p className="muted-text">Need at least 2 active participants to spin.</p>
          )}
        </div>
      </div>

      {isRenameModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-group-heading">
            <h2 id="rename-group-heading">Rename Group</h2>
            <p className="muted-text">Choose a new name between 1 and 60 characters.</p>
            <input
              className="text-input"
              value={renameDraftName}
              onChange={(event) => setRenameDraftName(event.target.value)}
              maxLength={60}
              autoFocus
            />
            {renameError && <p className="error-text">{renameError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  void audioEngine.playClick();
                  onConfirmRenameGroup();
                }}
                disabled={renameGroupMutation.isPending}
              >
                <span className="btn-content">
                  <IconSpark />
                  <span className="btn-label">
                    {renameGroupMutation.isPending ? "Renaming..." : "Rename"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  void audioEngine.playClick();
                  setRenameError(null);
                  setIsRenameModalOpen(false);
                }}
                disabled={renameGroupMutation.isPending}
              >
                <span className="btn-content">
                  <IconClose />
                  <span className="btn-label">Cancel</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {isParticipantModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal participant-modal" role="dialog" aria-modal="true" aria-labelledby="manage-participants-heading">
            <p className="eyebrow participant-modal-eyebrow">Group Setup</p>
            <h2 id="manage-participants-heading">Manage Participants</h2>
            <p className="muted-text participant-modal-copy">Changes apply only when you confirm.</p>

            <form className="participant-add-form" onSubmit={onAddDraftParticipant}>
              <input
                className="text-input"
                value={newParticipantName}
                onChange={(event) => setNewParticipantName(event.target.value)}
                placeholder="New participant name"
                maxLength={60}
              />
              <input
                className="text-input"
                value={newParticipantEmailId}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setNewParticipantEmailId(nextValue);
                  if (!normalizeEmailInput(nextValue)) {
                    setNewParticipantManager(false);
                  }
                }}
                placeholder="Email (optional)"
                maxLength={120}
              />
              <label className="participant-manager-field">
                <input
                  type="checkbox"
                  checked={newParticipantManager}
                  onChange={(event) => setNewParticipantManager(event.target.checked)}
                  disabled={!normalizeEmailInput(newParticipantEmailId)}
                />
                Manager
              </label>
              <button type="submit" className="primary-btn icon-btn add-btn" aria-label="Add participant to draft" title="Add participant to draft">
                <span className="add-btn-glyph" aria-hidden>
                  +
                </span>
                <span className="sr-only">Add participant</span>
              </button>
            </form>

            {newParticipantError && <p className="error-text participant-modal-error">{newParticipantError}</p>}

            <ul className="participant-edit-list">
              {participantDrafts.length === 0 && <li className="muted-text">No participants in draft.</li>}
              {participantDrafts.map((participant) => {
                const validEmail = normalizeEmailInput(participant.emailId);
                const isOwnerParticipant =
                  typeof group.ownerParticipantId === "string" &&
                  participant.participantId === group.ownerParticipantId;
                return (
                  <li key={participant.id} className="participant-edit-item">
                    <div className="participant-edit-name">{participant.name}</div>
                    <input
                      className="text-input"
                      value={participant.emailId}
                      disabled={isOwnerParticipant}
                      onChange={(event) => {
                        const nextEmailId = event.target.value;
                        setParticipantDrafts((current) =>
                          current.map((item) => {
                            if (item.id !== participant.id) {
                              return item;
                            }

                            return {
                              ...item,
                              emailId: nextEmailId,
                              manager: normalizeEmailInput(nextEmailId) ? item.manager : false,
                            };
                          }),
                        );
                      }}
                      placeholder="Email (optional)"
                      maxLength={120}
                    />
                    <label className="participant-manager-field">
                      <input
                        type="checkbox"
                        checked={participant.manager}
                        disabled={isOwnerParticipant || !validEmail}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setParticipantDrafts((current) =>
                            current.map((item) =>
                              item.id === participant.id ? { ...item, manager: checked } : item,
                            ),
                          );
                        }}
                      />
                      Manager
                    </label>
                    <button
                      type="button"
                      className="danger-btn icon-btn remove-btn"
                      aria-label={`Remove ${participant.name}`}
                      title={`Remove ${participant.name}`}
                      disabled={isOwnerParticipant}
                      onClick={() => {
                        setParticipantDrafts((current) =>
                          current.filter((item) => item.id !== participant.id),
                        );
                      }}
                    >
                      <IconTrash />
                      <span className="sr-only">Remove</span>
                    </button>
                    {!isValidOptionalEmail(participant.emailId) && (
                      <p className="error-text participant-inline-error">Invalid email format.</p>
                    )}
                    {isOwnerParticipant && (
                      <p className="muted-text participant-inline-error">
                        Owner settings are locked.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="modal-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onConfirmParticipantModal}
                disabled={commitParticipantsMutation.isPending || hasDraftValidationError || !hasDraftChanges}
              >
                <span className="btn-content">
                  <IconUsers />
                  <span className="btn-label">Confirm Changes</span>
                </span>
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setParticipantModalError(null);
                  setNewParticipantError(null);
                  setIsParticipantModalOpen(false);
                }}
                disabled={commitParticipantsMutation.isPending}
              >
                <span className="btn-content">
                  <IconClose />
                  <span className="btn-label">Cancel</span>
                </span>
              </button>
            </div>
            {participantModalError && <p className="error-text participant-modal-error">{participantModalError}</p>}
          </div>
        </div>
      )}

      {winner && (
        <div className="modal-backdrop" role="presentation">
          {winnerConfetti.length > 0 && (
            <div className="page-confetti" aria-hidden>
              {winnerConfetti.map((piece) => (
                <span
                  key={piece.id}
                  className="confetti-piece"
                  style={
                    {
                      left: `${piece.left}%`,
                      width: `${piece.sizePx}px`,
                      height: `${Math.max(4, piece.sizePx * 0.55)}px`,
                      backgroundColor: piece.color,
                      animationDelay: `${piece.delayMs}ms`,
                      animationDuration: `${piece.durationMs}ms`,
                      "--confetti-drift": `${piece.driftPx}px`,
                      "--confetti-rotate": `${piece.rotateDeg}deg`,
                    } as ConfettiStyle
                  }
                />
              ))}
            </div>
          )}
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="winner-heading"
          >
            <p className="eyebrow winner-tag">Winner</p>
            <h2 id="winner-heading">{winner.name}</h2>
            <p className="muted-text">The wheel has chosen the next lucky champion.</p>
            <div className="modal-actions">
              {canSaveOrDiscardWinner && (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    setSpinError(null);
                    if (!winnerSpinId) {
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
                  <span className="btn-content">
                    <IconSave />
                    <span className="btn-label">Save</span>
                  </span>
                </button>
              )}
              {canSaveOrDiscardWinner && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setSpinError(null);
                    if (!winnerSpinId) {
                      return;
                    }

                    discardSpinHistoryMutation.mutate(winnerSpinId, {
                      onSuccess: () => {
                        setWinner(null);
                        setWinnerSpinId(null);
                      },
                    });
                  }}
                  disabled={saveSpinHistoryMutation.isPending || discardSpinHistoryMutation.isPending}
                >
                  <span className="btn-content">
                    <IconClose />
                    <span className="btn-label">Discard</span>
                  </span>
                </button>
              )}
              {canRespinWinner && (
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
                  autoFocus={!canSaveOrDiscardWinner}
                  disabled={saveSpinHistoryMutation.isPending || discardSpinHistoryMutation.isPending}
                >
                  <span className="btn-content">
                    <IconRespin />
                    <span className="btn-label">Respin</span>
                  </span>
                </button>
              )}
              {!canSaveOrDiscardWinner && !canRespinWinner && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setSpinError(null);
                    setWinner(null);
                    setWinnerSpinId(null);
                  }}
                  autoFocus
                >
                  <span className="btn-content">
                    <IconClose />
                    <span className="btn-label">Close</span>
                  </span>
                </button>
              )}
            </div>
            {spinError && <p className="error-text">{spinError}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
