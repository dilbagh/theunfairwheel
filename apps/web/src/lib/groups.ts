import { useAuth, useUser } from "@clerk/clerk-react";
import { useMemo } from "react";
import type {
  GroupRealtimeCommand,
  GroupRealtimeEvent,
  GroupRealtimeServerMessage,
  GroupSocketSnapshot,
  GroupSpinState,
  GroupViewerAccess,
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
};

export type {
  GroupRealtimeCommand,
  GroupRealtimeEvent,
  GroupRealtimeServerMessage,
  GroupSocketSnapshot,
  GroupSpinState,
  GroupViewerAccess,
  SpinHistoryItem,
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
