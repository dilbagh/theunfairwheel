import { describe, expect, it } from "vitest";
import { deriveGroupPageAccess } from "./group-page-access";
import type { GroupViewerAccess } from "./groups";

function viewerAccess(overrides: Partial<GroupViewerAccess> = {}): GroupViewerAccess {
  return {
    isOwner: false,
    isParticipant: false,
    isManager: false,
    participantId: null,
    ...overrides,
  };
}

describe("deriveGroupPageAccess", () => {
  it("enables presence toggles, history, and spin for participants", () => {
    expect(deriveGroupPageAccess(viewerAccess({ isParticipant: true }))).toEqual({
      canTogglePresence: true,
      canSpin: true,
      canViewHistory: true,
    });
  });

  it("enables presence toggles, history, and spin for owners", () => {
    expect(deriveGroupPageAccess(viewerAccess({ isOwner: true }))).toEqual({
      canTogglePresence: true,
      canSpin: true,
      canViewHistory: true,
    });
  });

  it("disables presence toggles, history, and spin for non-participants", () => {
    expect(deriveGroupPageAccess(viewerAccess())).toEqual({
      canTogglePresence: false,
      canSpin: false,
      canViewHistory: false,
    });
  });
});
