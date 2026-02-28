export type Group = {
  id: string;
  name: string;
  createdAt: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerParticipantId: string;
};

export type GroupIndexRecord = Pick<
  Group,
  "id" | "name" | "createdAt" | "ownerUserId" | "ownerEmail"
>;

export type Participant = {
  id: string;
  name: string;
  active: boolean;
  emailId: string | null;
  manager: boolean;
  spinsSinceLastWon: number;
};

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function validateName(name: string): string {
  const normalized = normalizeName(name);

  if (!normalized || normalized.length > 60) {
    throw new Error("Name must be between 1 and 60 characters.");
  }

  return normalized;
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
