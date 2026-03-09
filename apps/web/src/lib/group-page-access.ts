import type { GroupViewerAccess } from "./groups";

export type GroupPageAccess = {
  canTogglePresence: boolean;
  canSpin: boolean;
  canViewHistory: boolean;
};

export function deriveGroupPageAccess(viewer: GroupViewerAccess | null): GroupPageAccess {
  const hasParticipantAccess = Boolean(viewer?.isParticipant || viewer?.isOwner);

  return {
    canTogglePresence: hasParticipantAccess,
    canSpin: hasParticipantAccess,
    canViewHistory: hasParticipantAccess,
  };
}
