import { useAuth } from "@clerk/clerk-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "../lib/audio";
import { connectGroupRealtime, type GroupRealtimeStatus } from "../lib/group-realtime";
import {
  ApiError,
  type GroupsApi,
  useCurrentUserEmailSet,
  useGroupsApi,
  type GroupRealtimeEvent,
  type GroupSpinState,
  type Participant,
} from "../lib/groups";
import { clearLastGroupId, setLastGroupId } from "../lib/storage";
import { activeParticipants, rotationForWinner, segmentColor, weightedSegments } from "../lib/wheel";

export const Route = createFileRoute("/groups/$groupId/")({
  component: GroupPage,
});

type GroupData = Awaited<ReturnType<GroupsApi["getGroup"]>>;

type ParticipantMutationContext = {
  previousParticipants: Participant[];
};

type ParticipantDraft = {
  id: string;
  participantId: string | null;
  name: string;
  active: boolean;
  spinsSinceLastWon: number;
  emailId: string;
  manager: boolean;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    manager: participant.manager,
  };
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

function IconShare() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 3h7v7h-2V6.41l-8.29 8.3-1.42-1.42 8.3-8.29H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m4 15.7 9.8-9.8 4.3 4.3-9.8 9.8H4v-4.3Zm2 2h1.4l8.6-8.6-1.4-1.4L6 16.3v1.4Zm12.9-8.9-4.3-4.3 1.1-1.1a1.5 1.5 0 0 1 2.1 0L20 5.6a1.5 1.5 0 0 1 0 2.1l-1.1 1.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconBookmark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-3-6 3V4.5ZM8.5 4a.5.5 0 0 0-.5.5v14.3l4-2 4 2V4.5a.5.5 0 0 0-.5-.5h-7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconBookmarkFilled() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-3-6 3V4.5Z" fill="currentColor" />
    </svg>
  );
}

function GroupPage() {
  const { groupId } = Route.useParams();
  const groupsApi = useGroupsApi();
  const { isSignedIn, userId } = useAuth();
  const userEmails = useCurrentUserEmailSet();
  const queryClient = useQueryClient();
  const [rotation, setRotation] = useState(0);
  const [spinDurationMs, setSpinDurationMs] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winner, setWinner] = useState<Participant | null>(null);
  const [winnerSpinId, setWinnerSpinId] = useState<string | null>(null);
  const [spinError, setSpinError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(audioEngine.isMuted());
  const [realtimeStatus, setRealtimeStatus] = useState<GroupRealtimeStatus>("connecting");
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

  const timeoutRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const shareFeedbackTimeoutRef = useRef<number | null>(null);
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

  const participants = useMemo(() => participantsQuery.data ?? [], [participantsQuery.data]);
  const currentUserParticipant = useMemo(
    () =>
      participants.find(
        (participant) =>
          typeof participant.emailId === "string" &&
          userEmails.has(participant.emailId.trim().toLowerCase()),
      ) ?? null,
    [participants, userEmails],
  );
  const canManageParticipants = Boolean(currentUserParticipant?.manager);
  const canSpin = Boolean(currentUserParticipant);
  const canViewHistory = Boolean(currentUserParticipant);
  const bookmarkedGroupIds = bookmarkedGroupIdsQuery.data ?? [];
  const isGroupBookmarked = bookmarkedGroupIds.includes(groupId);
  const eligibleParticipants = useMemo(() => activeParticipants(participants), [participants]);
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
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const clearShareFeedbackTimer = () => {
    if (shareFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(shareFeedbackTimeoutRef.current);
      shareFeedbackTimeoutRef.current = null;
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

      case "group.updated": {
        queryClient.setQueryData<GroupData>(["groups", groupId], event.payload.group);
        break;
      }

      case "participant.added": {
        queryClient.setQueryData<Participant[]>(["participants", groupId], (current = []) =>
          dedupeParticipantsById([...current, event.payload.participant]),
        );
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
      clearShareFeedbackTimer();
    };
  }, []);

  useEffect(() => {
    if (groupQuery.data?.id) {
      setLastGroupId(groupQuery.data.id);
    }
  }, [groupQuery.data]);

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

  const commitParticipantsMutation = useMutation({
    mutationFn: (input: {
      adds: Array<{ name: string; emailId: string | null; manager: boolean }>;
      updates: Array<{ participantId: string; emailId: string | null; manager: boolean }>;
      removes: string[];
    }) => groupsApi.commitParticipants({ groupId, ...input }),
    onError: (error: Error) => {
      setParticipantModalError(error.message);
    },
    onSuccess: async (nextParticipants) => {
      queryClient.setQueryData<Participant[]>(["participants", groupId], nextParticipants);
      await queryClient.invalidateQueries({ queryKey: ["participants", groupId] });
      setParticipantModalError(null);
      setNewParticipantError(null);
      setIsParticipantModalOpen(false);
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

  const renameGroupMutation = useMutation({
    mutationFn: (name: string) => groupsApi.renameGroup({ groupId, name }),
    onError: (error: Error) => {
      setRenameError(error.message);
    },
    onSuccess: (nextGroup) => {
      queryClient.setQueryData<GroupData>(["groups", groupId], nextGroup);
      setRenameError(null);
      setIsRenameModalOpen(false);
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

      if ((current.emailId ?? null) !== draftEmail || current.manager !== draftManager) {
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
      if ((participant.emailId ?? null) !== emailId || participant.manager !== manager) {
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

  const isGroupOwner = Boolean(userId && group.ownerUserId === userId);
  const canBookmarkGroup = isSignedIn && Boolean(userId) && !isGroupOwner;
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
          <p
            className={`connection-status ${
              isRealtimeConnected ? "connection-status-connected" : "connection-status-disconnected"
            }`}
          >
            <span className="connection-status-dot" aria-hidden />
            <span>{isRealtimeConnected ? "Connected" : "Disconnected"}</span>
          </p>
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
                Manage Participants
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
                  disabled={!canSpin}
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
              View History
            </Link>
          ) : (
            <button type="button" className="ghost-btn participant-history-link" disabled>
              View History
            </button>
          )}
          {!isSignedIn && <p className="muted-text">Log in to manage participants.</p>}
          {isSignedIn && !canSpin && (
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
            {isSpinning || isSpinRequestPending ? "Spinning..." : "Spin the Wheel"}
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
                {renameGroupMutation.isPending ? "Renaming..." : "Rename"}
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
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {isParticipantModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal participant-modal" role="dialog" aria-modal="true" aria-labelledby="manage-participants-heading">
            <h2 id="manage-participants-heading">Manage Participants</h2>
            <p className="muted-text">Changes apply only when you confirm.</p>

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

            {newParticipantError && <p className="error-text">{newParticipantError}</p>}

            <ul className="participant-edit-list">
              {participantDrafts.length === 0 && <li className="muted-text">No participants in draft.</li>}
              {participantDrafts.map((participant) => {
                const validEmail = normalizeEmailInput(participant.emailId);
                const isOwnerParticipant = participant.participantId === group.ownerParticipantId;
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
                Confirm Changes
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
                Cancel
              </button>
            </div>
            {participantModalError && <p className="error-text">{participantModalError}</p>}
          </div>
        </div>
      )}

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
