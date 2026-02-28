import {
  STORAGE_KEYS,
  getJSON,
  participantsKey,
  setJSON,
} from "./storage";

export type Group = {
  id: string;
  name: string;
  createdAt: string;
};

export type Participant = {
  id: string;
  name: string;
  active: boolean;
};

export type GameSettings = {
  removeWinnerAfterSpin: boolean;
};

export type GroupsApi = {
  createGroup(input: { name: string }): Promise<Group>;
  getGroup(input: { id: string }): Promise<Group>;
  listParticipants(input: { groupId: string }): Promise<Participant[]>;
  addParticipant(input: { groupId: string; name: string }): Promise<Participant>;
  removeParticipant(input: {
    groupId: string;
    participantId: string;
  }): Promise<void>;
  setParticipantActive(input: {
    groupId: string;
    participantId: string;
    active: boolean;
  }): Promise<Participant>;
};

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function validateName(name: string): string {
  const normalized = normalizeName(name);

  if (!normalized || normalized.length > 60) {
    throw new Error("Name must be between 1 and 60 characters.");
  }

  return normalized;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadGroups(): Group[] {
  return getJSON<Group[]>(STORAGE_KEYS.groups, []);
}

function saveGroups(groups: Group[]) {
  setJSON(STORAGE_KEYS.groups, groups);
}

function loadParticipants(groupId: string): Participant[] {
  return getJSON<Participant[]>(participantsKey(groupId), []);
}

function saveParticipants(groupId: string, participants: Participant[]) {
  setJSON(participantsKey(groupId), participants);
}

function randomDelay() {
  return new Promise<void>((resolve) => {
    const ms = 150 + Math.floor(Math.random() * 250);
    setTimeout(resolve, ms);
  });
}

const mockGroupsApi: GroupsApi = {
  async createGroup(input) {
    await randomDelay();

    const name = validateName(input.name);
    const group: Group = {
      id: randomId(),
      name,
      createdAt: new Date().toISOString(),
    };

    const groups = loadGroups();
    groups.push(group);
    saveGroups(groups);
    saveParticipants(group.id, []);

    return group;
  },

  async getGroup(input) {
    await randomDelay();

    const groups = loadGroups();
    const group = groups.find((item) => item.id === input.id);

    if (!group) {
      throw new Error("Group not found.");
    }

    return group;
  },

  async listParticipants(input) {
    await randomDelay();
    return loadParticipants(input.groupId);
  },

  async addParticipant(input) {
    await randomDelay();

    const name = validateName(input.name);
    const participants = loadParticipants(input.groupId);

    if (
      participants.some(
        (participant) =>
          participant.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      throw new Error("Participant with this name already exists.");
    }

    const participant: Participant = {
      id: randomId(),
      name,
      active: true,
    };

    participants.push(participant);
    saveParticipants(input.groupId, participants);

    return participant;
  },

  async removeParticipant(input) {
    await randomDelay();

    const participants = loadParticipants(input.groupId).filter(
      (participant) => participant.id !== input.participantId,
    );

    saveParticipants(input.groupId, participants);
  },

  async setParticipantActive(input) {
    await randomDelay();

    const participants = loadParticipants(input.groupId);
    const participant = participants.find((item) => item.id === input.participantId);

    if (!participant) {
      throw new Error("Participant not found.");
    }

    participant.active = input.active;
    saveParticipants(input.groupId, participants);

    return participant;
  },
};

// Swap this instance with real backend wiring when API routes are available.
export const groupsApi: GroupsApi = mockGroupsApi;
