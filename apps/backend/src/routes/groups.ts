import { Hono } from "hono";
import { validator } from "hono/validator";
import { getAuthContext, type AuthContext } from "../auth";
import {
  randomId,
  type Group,
  type GroupIndexRecord,
  type Participant,
  validateName,
} from "../domain/group";
import type { AppEnv, DurableObjectStubLike } from "../types";

type ErrorBody = {
  error: string;
};

type GroupAccessProfile = {
  group: Group;
  participant: Participant | null;
  isOwner: boolean;
  isParticipant: boolean;
  isManager: boolean;
};

type AppContext = import("hono").Context<AppEnv>;

const createGroupBody = validator("json", (value) => value as { name?: string });
const renameGroupBody = validator("json", (value) => value as { name?: string });
const addParticipantBody = validator("json", (value) =>
  value as { name?: string; emailId?: string | null; manager?: boolean },
);
const updateParticipantBody = validator("json", (value) =>
  value as { active?: boolean; emailId?: string | null; manager?: boolean },
);
const commitParticipantsBody = validator("json", (value) =>
  value as {
    adds?: Array<{ name?: string; emailId?: string | null; manager?: boolean }>;
    updates?: Array<{
      participantId?: string;
      emailId?: string | null;
      manager?: boolean;
    }>;
    removes?: string[];
  },
);
const bookmarksBody = validator("json", (value) => value as { groupIds?: string[] });

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ownerGroupKey(ownerUserId: string, groupId: string): string {
  return `owner-group:${ownerUserId}:${groupId}`;
}

function groupKey(groupId: string): string {
  return `group:${groupId}`;
}

function participantGroupKey(email: string, groupId: string): string {
  return `participant-group:${normalizeEmail(email)}:${groupId}`;
}

function participantIndexKey(groupId: string): string {
  return `participant-index:${groupId}`;
}

function bookmarksKey(userId: string): string {
  return `bookmarks:${userId}`;
}

function groupStub(c: { env: AppEnv["Bindings"] }, groupId: string): DurableObjectStubLike {
  const id = c.env.GROUPS_DO.idFromName(groupId);
  return c.env.GROUPS_DO.get(id);
}

async function callDurableObject(
  stub: DurableObjectStubLike,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return stub.fetch(`https://do${path}`, init);
}

async function parseError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as ErrorBody;
    return json.error || "Request failed.";
  } catch {
    return "Request failed.";
  }
}

async function requireAuth(c: AppContext): Promise<AuthContext | Response> {
  const auth = await getAuthContext(c);
  if (!auth.isAuthenticated || !auth.userId) {
    return c.json({ error: "Authentication required." }, 401);
  }

  return auth;
}

async function getGroup(groupId: string, c: AppContext): Promise<Group | null> {
  const response = await callDurableObject(groupStub(c, groupId), "/group");
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as Group;
}

async function getParticipants(
  groupId: string,
  c: AppContext,
): Promise<Participant[] | null> {
  const response = await callDurableObject(groupStub(c, groupId), "/participants");
  if (!response.ok) {
    return null;
  }

  return (await response.json()) as Participant[];
}

async function getGroupAccessProfile(
  c: AppContext,
  groupId: string,
  auth: AuthContext,
): Promise<GroupAccessProfile | null> {
  const [group, participants] = await Promise.all([getGroup(groupId, c), getParticipants(groupId, c)]);

  if (!group || !participants) {
    return null;
  }

  const matchedParticipant = participants.find((participant) => {
    if (!participant.emailId) {
      return false;
    }

    return auth.verifiedEmails.includes(normalizeEmail(participant.emailId));
  });

  const isOwner = auth.userId === group.ownerUserId;
  const isParticipant = Boolean(matchedParticipant);

  return {
    group,
    participant: matchedParticipant ?? null,
    isOwner,
    isParticipant,
    isManager: Boolean(matchedParticipant?.manager),
  };
}

async function requireParticipant(
  c: AppContext,
  groupId: string,
): Promise<GroupAccessProfile | Response> {
  const auth = await requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }

  const profile = await getGroupAccessProfile(c, groupId, auth);
  if (!profile) {
    return c.json({ error: "Group not found." }, 404);
  }

  if (!profile.isParticipant && !profile.isOwner) {
    return c.json({ error: "You do not have access to this group." }, 403);
  }

  return profile;
}

async function requireManager(
  c: AppContext,
  groupId: string,
): Promise<GroupAccessProfile | Response> {
  const participantAccess = await requireParticipant(c, groupId);
  if (participantAccess instanceof Response) {
    return participantAccess;
  }

  if (!participantAccess.isManager) {
    return c.json({ error: "Manager access is required." }, 403);
  }

  return participantAccess;
}

async function listAllKeys(
  c: AppContext,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await c.env.GROUP_INDEX_KV.list({ prefix, cursor, limit: 1000 });
    for (const key of result.keys) {
      keys.push(key.name);
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return keys;
}

function parseEmailsFromIndex(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeEmail(item));
  } catch {
    return [];
  }
}

function parseGroupIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const ids = parsed.filter((item): item is string => typeof item === "string");
    return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
  } catch {
    return [];
  }
}

async function syncParticipantGroupIndex(
  c: AppContext,
  groupId: string,
  participants: Participant[],
): Promise<void> {
  const existingRaw = await c.env.GROUP_INDEX_KV.get(participantIndexKey(groupId));
  const previousEmails = new Set(parseEmailsFromIndex(existingRaw));
  const nextEmails = new Set(
    participants
      .map((participant) => participant.emailId)
      .filter((emailId): emailId is string => typeof emailId === "string" && emailId.trim().length > 0)
      .map((emailId) => normalizeEmail(emailId)),
  );

  for (const email of previousEmails) {
    if (!nextEmails.has(email)) {
      await c.env.GROUP_INDEX_KV.delete(participantGroupKey(email, groupId));
    }
  }

  for (const email of nextEmails) {
    if (!previousEmails.has(email)) {
      await c.env.GROUP_INDEX_KV.put(participantGroupKey(email, groupId), "1");
    }
  }

  await c.env.GROUP_INDEX_KV.put(participantIndexKey(groupId), JSON.stringify(Array.from(nextEmails).sort()));
}

const groupsRoutes = new Hono<AppEnv>()
  .post("/groups", createGroupBody, async (c) => {
    const auth = await requireAuth(c);
    if (auth instanceof Response) {
      return auth;
    }

    const body = c.req.valid("json");
    const name = validateName(body.name ?? "");

    if (!auth.verifiedEmails.length) {
      return c.json({ error: "At least one verified email is required." }, 400);
    }

    const ownerEmail = auth.primaryEmail ?? auth.verifiedEmails[0] ?? null;
    if (!ownerEmail) {
      return c.json({ error: "At least one verified email is required." }, 400);
    }
    const ownerUserId = auth.userId;
    if (!ownerUserId) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const groupId = randomId();
    const ownerParticipantId = randomId();
    const ownerNameFromProfile = (auth.firstName ?? "").trim();
    const ownerName =
      ownerNameFromProfile || ownerEmail.split("@")[0]?.trim() || "Owner";

    const group: Group = {
      id: groupId,
      name,
      createdAt: new Date().toISOString(),
      ownerUserId,
      ownerEmail,
      ownerParticipantId,
    };

    const ownerParticipant: Participant = {
      id: ownerParticipantId,
      name: ownerName.slice(0, 60),
      active: true,
      emailId: ownerEmail,
      manager: true,
      spinsSinceLastWon: 0,
    };

    const stub = groupStub(c, group.id);
    const initResponse = await callDurableObject(stub, "/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group, ownerParticipant }),
    });

    if (!initResponse.ok) {
      return c.json(
        { error: await parseError(initResponse) },
        initResponse.status as 400 | 500,
      );
    }

    const indexRecord: GroupIndexRecord = {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      ownerUserId: group.ownerUserId,
      ownerEmail: group.ownerEmail,
    };

    await c.env.GROUP_INDEX_KV.put(groupKey(group.id), JSON.stringify(indexRecord));
    await c.env.GROUP_INDEX_KV.put(ownerGroupKey(group.ownerUserId, group.id), "1");
    await syncParticipantGroupIndex(c, group.id, [ownerParticipant]);

    return c.json(group, 201);
  })
  .get("/groups/me", async (c) => {
    const auth = await requireAuth(c);
    if (auth instanceof Response) {
      return auth;
    }

    const groupIds = new Set<string>();

    const ownerKeys = await listAllKeys(c, `owner-group:${auth.userId}:`);
    for (const key of ownerKeys) {
      const groupId = key.slice(`owner-group:${auth.userId}:`.length);
      if (groupId) {
        groupIds.add(groupId);
      }
    }

    for (const email of auth.verifiedEmails) {
      const participantKeys = await listAllKeys(c, `participant-group:${email}:`);
      for (const key of participantKeys) {
        const groupId = key.slice(`participant-group:${email}:`.length);
        if (groupId) {
          groupIds.add(groupId);
        }
      }
    }

    const groups: GroupIndexRecord[] = [];
    for (const groupId of groupIds) {
      const raw = await c.env.GROUP_INDEX_KV.get(groupKey(groupId));
      if (!raw) {
        continue;
      }

      try {
        const record = JSON.parse(raw) as GroupIndexRecord;
        groups.push(record);
      } catch {
        // Ignore malformed KV data.
      }
    }

    groups.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    return c.json(groups);
  })
  .get("/groups/bookmarks", async (c) => {
    const auth = await requireAuth(c);
    if (auth instanceof Response) {
      return auth;
    }

    const userId = auth.userId;
    if (!userId) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const raw = await c.env.GROUP_INDEX_KV.get(bookmarksKey(userId));
    return c.json(parseGroupIds(raw));
  })
  .put("/groups/bookmarks", bookmarksBody, async (c) => {
    const auth = await requireAuth(c);
    if (auth instanceof Response) {
      return auth;
    }

    const userId = auth.userId;
    if (!userId) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const body = c.req.valid("json");
    const normalized = Array.isArray(body.groupIds)
      ? Array.from(
          new Set(
            body.groupIds
              .filter((groupId): groupId is string => typeof groupId === "string")
              .map((groupId) => groupId.trim())
              .filter((groupId) => groupId.length > 0),
          ),
        )
      : [];

    await c.env.GROUP_INDEX_KV.put(bookmarksKey(userId), JSON.stringify(normalized));
    return c.json(normalized);
  })
  .get("/groups/:groupId", async (c) => {
    const groupId = c.req.param("groupId");
    const response = await callDurableObject(groupStub(c, groupId), "/group");

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    return c.json(await response.json());
  })
  .patch("/groups/:groupId", renameGroupBody, async (c) => {
    const groupId = c.req.param("groupId");
    const managerAccess = await requireManager(c, groupId);
    if (managerAccess instanceof Response) {
      return managerAccess;
    }

    const body = c.req.valid("json");

    const response = await callDurableObject(groupStub(c, groupId), "/group", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: body.name }),
    });

    if (!response.ok) {
      return c.json(
        { error: await parseError(response) },
        response.status as 400 | 404 | 500,
      );
    }

    const renamedGroup = (await response.json()) as Group;
    const indexRecord: GroupIndexRecord = {
      id: renamedGroup.id,
      name: renamedGroup.name,
      createdAt: renamedGroup.createdAt,
      ownerUserId: renamedGroup.ownerUserId,
      ownerEmail: renamedGroup.ownerEmail,
    };
    await c.env.GROUP_INDEX_KV.put(groupKey(renamedGroup.id), JSON.stringify(indexRecord));

    return c.json(renamedGroup);
  })
  .get("/groups/:groupId/ws", async (c) => {
    const groupId = c.req.param("groupId");
    const response = await callDurableObject(groupStub(c, groupId), "/ws", {
      method: "GET",
      headers: c.req.raw.headers,
    });

    if (response.status === 101) {
      return response;
    }

    return c.json({ error: await parseError(response) }, response.status as 400 | 404 | 500);
  })
  .post("/groups/:groupId/spin", async (c) => {
    const groupId = c.req.param("groupId");
    const participantAccess = await requireParticipant(c, groupId);
    if (participantAccess instanceof Response) {
      return participantAccess;
    }

    const response = await callDurableObject(groupStub(c, groupId), "/spin", {
      method: "POST",
    });

    if (!response.ok) {
      return c.json(
        { error: await parseError(response) },
        response.status as 404 | 409 | 500,
      );
    }

    return c.json(await response.json(), 202);
  })
  .get("/groups/:groupId/history", async (c) => {
    const groupId = c.req.param("groupId");
    const participantAccess = await requireParticipant(c, groupId);
    if (participantAccess instanceof Response) {
      return participantAccess;
    }

    const response = await callDurableObject(groupStub(c, groupId), "/history");

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    return c.json(await response.json());
  })
  .delete("/groups/:groupId/history/:spinId", async (c) => {
    const groupId = c.req.param("groupId");
    const spinId = c.req.param("spinId");
    const participantAccess = await requireParticipant(c, groupId);
    if (participantAccess instanceof Response) {
      return participantAccess;
    }

    const response = await callDurableObject(
      groupStub(c, groupId),
      `/history/${spinId}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 400 | 404 | 500);
    }

    return c.body(null, 204);
  })
  .post("/groups/:groupId/history/:spinId/save", async (c) => {
    const groupId = c.req.param("groupId");
    const spinId = c.req.param("spinId");
    const participantAccess = await requireParticipant(c, groupId);
    if (participantAccess instanceof Response) {
      return participantAccess;
    }

    const response = await callDurableObject(
      groupStub(c, groupId),
      `/history/${spinId}/save`,
      { method: "POST" },
    );

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 400 | 404 | 500);
    }

    return c.body(null, 204);
  })
  .get("/groups/:groupId/participants", async (c) => {
    const groupId = c.req.param("groupId");
    const response = await callDurableObject(groupStub(c, groupId), "/participants");

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    return c.json(await response.json());
  })
  .post("/groups/:groupId/participants", addParticipantBody, async (c) => {
    const groupId = c.req.param("groupId");
    const managerAccess = await requireManager(c, groupId);
    if (managerAccess instanceof Response) {
      return managerAccess;
    }

    const body = c.req.valid("json");

    const response = await callDurableObject(groupStub(c, groupId), "/participants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return c.json(
        { error: await parseError(response) },
        response.status as 400 | 404 | 409 | 500,
      );
    }

    const created = (await response.json()) as Participant;
    const participants = await getParticipants(groupId, c);
    if (participants) {
      await syncParticipantGroupIndex(c, groupId, participants);
    }

    return c.json(created, 201);
  })
  .patch("/groups/:groupId/participants/:participantId", updateParticipantBody, async (c) => {
    const groupId = c.req.param("groupId");
    const participantId = c.req.param("participantId");
    const managerAccess = await requireManager(c, groupId);
    if (managerAccess instanceof Response) {
      return managerAccess;
    }

    const body = c.req.valid("json");

    const response = await callDurableObject(
      groupStub(c, groupId),
      `/participants/${participantId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      return c.json(
        { error: await parseError(response) },
        response.status as 400 | 404 | 500,
      );
    }

    const updated = (await response.json()) as Participant;
    const participants = await getParticipants(groupId, c);
    if (participants) {
      await syncParticipantGroupIndex(c, groupId, participants);
    }

    return c.json(updated);
  })
  .post("/groups/:groupId/participants/commit", commitParticipantsBody, async (c) => {
    const groupId = c.req.param("groupId");
    const managerAccess = await requireManager(c, groupId);
    if (managerAccess instanceof Response) {
      return managerAccess;
    }

    const body = c.req.valid("json");

    const response = await callDurableObject(groupStub(c, groupId), "/participants/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return c.json(
        { error: await parseError(response) },
        response.status as 400 | 404 | 409 | 500,
      );
    }

    const participants = (await response.json()) as Participant[];
    await syncParticipantGroupIndex(c, groupId, participants);

    return c.json(participants);
  })
  .delete("/groups/:groupId/participants/:participantId", async (c) => {
    const groupId = c.req.param("groupId");
    const participantId = c.req.param("participantId");
    const managerAccess = await requireManager(c, groupId);
    if (managerAccess instanceof Response) {
      return managerAccess;
    }

    const response = await callDurableObject(
      groupStub(c, groupId),
      `/participants/${participantId}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    const participants = await getParticipants(groupId, c);
    if (participants) {
      await syncParticipantGroupIndex(c, groupId, participants);
    }

    return c.body(null, 204);
  });

export { groupsRoutes };
