import { apiClient } from "./api-client";

export type GameSettings = {
  removeWinnerAfterSpin: boolean;
};

export type Group = {
  id: string;
  name: string;
  createdAt: string;
  settings: GameSettings;
};

export type Participant = {
  id: string;
  name: string;
  active: boolean;
};

export type GroupsApi = {
  createGroup(input: { name: string }): Promise<Group>;
  getGroup(input: { id: string }): Promise<Group>;
  updateGroupSettings(input: { groupId: string; settings: GameSettings }): Promise<GameSettings>;
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

  async updateGroupSettings(input) {
    const response = await apiClient.groups[":groupId"].settings.$patch({
      param: { groupId: input.groupId },
      json: {
        removeWinnerAfterSpin: input.settings.removeWinnerAfterSpin,
      },
    });

    return expectJson<GameSettings>(response);
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
