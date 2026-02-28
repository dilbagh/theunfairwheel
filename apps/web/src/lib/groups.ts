import type {
  GroupRealtimeEvent,
  GroupSpinState,
  SpinHistoryItem,
} from "@repo/backend";
import { apiClient } from "./api-client";

export type Group = {
  id: string;
  name: string;
  createdAt: string;
};

export type Participant = {
  id: string;
  name: string;
  active: boolean;
  spinsSinceLastWon: number;
};

export type GroupsApi = {
  createGroup(input: { name: string }): Promise<Group>;
  getGroup(input: { id: string }): Promise<Group>;
  requestSpin(input: { groupId: string }): Promise<{ spin: GroupSpinState }>;
  listSpinHistory(input: { groupId: string }): Promise<SpinHistoryItem[]>;
  saveSpinHistoryItem(input: { groupId: string; spinId: string }): Promise<void>;
  discardSpinHistoryItem(input: { groupId: string; spinId: string }): Promise<void>;
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

export type { GroupRealtimeEvent, GroupSpinState };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? "Request failed.";
  } catch {
    return "Request failed.";
  }
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }

  return (await response.json()) as T;
}

const httpGroupsApi: GroupsApi = {
  async createGroup(input) {
    const response = await apiClient.groups.$post({
      json: {
        name: input.name,
      },
    });

    return expectJson<Group>(response);
  },

  async getGroup(input) {
    const response = await apiClient.groups[":groupId"].$get({
      param: { groupId: input.id },
    });

    return expectJson<Group>(response);
  },

  async requestSpin(input) {
    const response = await apiClient.groups[":groupId"].spin.$post({
      param: { groupId: input.groupId },
    });

    return expectJson<{ spin: GroupSpinState }>(response);
  },

  async listSpinHistory(input) {
    const response = await apiClient.groups[":groupId"].history.$get({
      param: { groupId: input.groupId },
    });

    return expectJson<SpinHistoryItem[]>(response);
  },

  async saveSpinHistoryItem(input) {
    const response = await apiClient.groups[":groupId"].history[":spinId"].save.$post({
      param: {
        groupId: input.groupId,
        spinId: input.spinId,
      },
    });

    if (!response.ok) {
      throw new ApiError(await readError(response), response.status);
    }
  },

  async discardSpinHistoryItem(input) {
    const response = await apiClient.groups[":groupId"].history[":spinId"].$delete({
      param: {
        groupId: input.groupId,
        spinId: input.spinId,
      },
    });

    if (!response.ok) {
      throw new ApiError(await readError(response), response.status);
    }
  },

  async listParticipants(input) {
    const response = await apiClient.groups[":groupId"].participants.$get({
      param: { groupId: input.groupId },
    });

    return expectJson<Participant[]>(response);
  },

  async addParticipant(input) {
    const response = await apiClient.groups[":groupId"].participants.$post({
      param: { groupId: input.groupId },
      json: {
        name: input.name,
      },
    });

    return expectJson<Participant>(response);
  },

  async removeParticipant(input) {
    const response = await apiClient.groups[":groupId"].participants[":participantId"].$delete(
      {
        param: {
          groupId: input.groupId,
          participantId: input.participantId,
        },
      },
    );

    if (!response.ok) {
      throw new ApiError(await readError(response), response.status);
    }
  },

  async setParticipantActive(input) {
    const response = await apiClient.groups[":groupId"].participants[":participantId"].$patch(
      {
        param: {
          groupId: input.groupId,
          participantId: input.participantId,
        },
        json: {
          active: input.active,
        },
      },
    );

    return expectJson<Participant>(response);
  },
};

export const groupsApi: GroupsApi = httpGroupsApi;
