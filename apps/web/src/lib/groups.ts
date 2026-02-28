import { useAuth, useUser } from "@clerk/clerk-react";
import { useMemo } from "react";
import type {
  GroupRealtimeEvent,
  GroupSpinState,
  SpinHistoryItem,
} from "@repo/backend";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";

export type Group = {
  id: string;
  name: string;
  createdAt: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerParticipantId: string;
};

export type GroupSummary = Pick<Group, "id" | "name" | "createdAt" | "ownerUserId" | "ownerEmail">;

export type Participant = {
  id: string;
  name: string;
  active: boolean;
  emailId: string | null;
  manager: boolean;
  spinsSinceLastWon: number;
};

export type GroupsApi = {
  createGroup(input: { name: string }): Promise<Group>;
  listMyGroups(): Promise<GroupSummary[]>;
  listBookmarkedGroupIds(): Promise<string[]>;
  setBookmarkedGroupIds(input: { groupIds: string[] }): Promise<string[]>;
  getGroup(input: { id: string }): Promise<Group>;
  renameGroup(input: { groupId: string; name: string }): Promise<Group>;
  requestSpin(input: { groupId: string }): Promise<{ spin: GroupSpinState }>;
  listSpinHistory(input: { groupId: string }): Promise<SpinHistoryItem[]>;
  saveSpinHistoryItem(input: { groupId: string; spinId: string }): Promise<void>;
  discardSpinHistoryItem(input: { groupId: string; spinId: string }): Promise<void>;
  listParticipants(input: { groupId: string }): Promise<Participant[]>;
  addParticipant(input: {
    groupId: string;
    name: string;
    emailId?: string | null;
    manager?: boolean;
  }): Promise<Participant>;
  removeParticipant(input: {
    groupId: string;
    participantId: string;
  }): Promise<void>;
  setParticipantActive(input: {
    groupId: string;
    participantId: string;
    active: boolean;
  }): Promise<Participant>;
  commitParticipants(input: {
    groupId: string;
    adds: Array<{ name: string; emailId: string | null; manager: boolean }>;
    updates: Array<{ participantId: string; emailId: string | null; manager: boolean }>;
    removes: string[];
  }): Promise<Participant[]>;
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

function url(path: string): string {
  return `${baseUrl}${path}`;
}

type TokenFactory = () => Promise<string | null>;

async function request(
  path: string,
  init: RequestInit,
  getToken?: TokenFactory,
): Promise<Response> {
  const headers = new Headers(init.headers ?? undefined);

  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  if (getToken) {
    const token = await getToken();
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
  }

  return fetch(url(path), {
    ...init,
    headers,
  });
}

export function createGroupsApi(getToken?: TokenFactory): GroupsApi {
  return {
    async createGroup(input) {
      const response = await request(
        "/groups",
        {
          method: "POST",
          body: JSON.stringify({ name: input.name }),
        },
        getToken,
      );

      return expectJson<Group>(response);
    },

    async listMyGroups() {
      const response = await request(
        "/groups/me",
        {
          method: "GET",
        },
        getToken,
      );

      return expectJson<GroupSummary[]>(response);
    },

    async listBookmarkedGroupIds() {
      const response = await request(
        "/groups/bookmarks",
        {
          method: "GET",
        },
        getToken,
      );

      return expectJson<string[]>(response);
    },

    async setBookmarkedGroupIds(input) {
      const response = await request(
        "/groups/bookmarks",
        {
          method: "PUT",
          body: JSON.stringify({ groupIds: input.groupIds }),
        },
        getToken,
      );

      return expectJson<string[]>(response);
    },

    async getGroup(input) {
      const response = await request(`/groups/${encodeURIComponent(input.id)}`, { method: "GET" });
      return expectJson<Group>(response);
    },

    async renameGroup(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: input.name }),
        },
        getToken,
      );

      return expectJson<Group>(response);
    },

    async requestSpin(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/spin`,
        { method: "POST" },
        getToken,
      );

      return expectJson<{ spin: GroupSpinState }>(response);
    },

    async listSpinHistory(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/history`,
        { method: "GET" },
        getToken,
      );

      return expectJson<SpinHistoryItem[]>(response);
    },

    async saveSpinHistoryItem(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/history/${encodeURIComponent(input.spinId)}/save`,
        { method: "POST" },
        getToken,
      );

      if (!response.ok) {
        throw new ApiError(await readError(response), response.status);
      }
    },

    async discardSpinHistoryItem(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/history/${encodeURIComponent(input.spinId)}`,
        { method: "DELETE" },
        getToken,
      );

      if (!response.ok) {
        throw new ApiError(await readError(response), response.status);
      }
    },

    async listParticipants(input) {
      const response = await request(`/groups/${encodeURIComponent(input.groupId)}/participants`, {
        method: "GET",
      });

      return expectJson<Participant[]>(response);
    },

    async addParticipant(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/participants`,
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            emailId: input.emailId,
            manager: input.manager,
          }),
        },
        getToken,
      );

      return expectJson<Participant>(response);
    },

    async removeParticipant(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/participants/${encodeURIComponent(input.participantId)}`,
        {
          method: "DELETE",
        },
        getToken,
      );

      if (!response.ok) {
        throw new ApiError(await readError(response), response.status);
      }
    },

    async setParticipantActive(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/participants/${encodeURIComponent(input.participantId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ active: input.active }),
        },
        getToken,
      );

      return expectJson<Participant>(response);
    },

    async commitParticipants(input) {
      const response = await request(
        `/groups/${encodeURIComponent(input.groupId)}/participants/commit`,
        {
          method: "POST",
          body: JSON.stringify({
            adds: input.adds,
            updates: input.updates,
            removes: input.removes,
          }),
        },
        getToken,
      );

      return expectJson<Participant[]>(response);
    },
  };
}

const anonymousGroupsApi = createGroupsApi();

export function useGroupsApi(): GroupsApi {
  const { getToken } = useAuth();
  return useMemo(() => createGroupsApi(() => getToken()), [getToken]);
}

export function useCurrentUserEmailSet(): Set<string> {
  const { user } = useUser();

  return useMemo(() => {
    if (!user) {
      return new Set<string>();
    }

    return new Set(
      user.emailAddresses
        .filter((email) => email.verification?.status === "verified")
        .map((email) => email.emailAddress.trim().toLowerCase()),
    );
  }, [user]);
}

export const groupsApi: GroupsApi = anonymousGroupsApi;
