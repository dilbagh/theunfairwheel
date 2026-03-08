import { Hono } from "hono";
import { validator } from "hono/validator";
import { getAuthContext } from "../auth";
import { randomId, type Group, type GroupIndexRecord, type Participant, validateName } from "../domain/group";
import type { GroupRealtimeServerMessage, GroupViewerIdentity } from "../domain/realtime";
import type { AppEnv, DurableObjectStubLike } from "../types";

type ErrorBody = {
  error: string;
};

type AppContext = import("hono").Context<AppEnv>;
type BridgeSocket = WebSocket & { accept(): void };
type UpgradedResponse = Response & { webSocket?: WebSocket };

const VIEWER_HEADER = "x-group-viewer";

const createGroupBody = validator("json", (value) => value as { name?: string });
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

async function requireAuth(c: AppContext) {
  const auth = await getAuthContext(c);
  if (!auth.isAuthenticated || !auth.userId) {
    return c.json({ error: "Authentication required." }, 401);
  }

  return auth;
}

async function listAllKeys(c: AppContext, prefix: string): Promise<string[]> {
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

function encodeViewer(viewer: GroupViewerIdentity): string {
  return btoa(JSON.stringify(viewer));
}

async function syncFromDoMessage(c: AppContext, message: GroupRealtimeServerMessage): Promise<void> {
  if (message.type !== "command.ok" || !message.payload.sync) {
    return;
  }

  const { group, participants } = message.payload.sync;
  if (group) {
    const indexRecord: GroupIndexRecord = {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      ownerUserId: group.ownerUserId,
      ownerEmail: group.ownerEmail,
    };
    await c.env.GROUP_INDEX_KV.put(groupKey(group.id), JSON.stringify(indexRecord));
  }

  if (participants) {
    await syncParticipantGroupIndex(c, message.groupId, participants);
  }
}

function relayClose(source: BridgeSocket, target: BridgeSocket, code = 1000, reason?: string): void {
  try {
    target.close(code, reason);
  } catch {
    // no-op
  }

  try {
    source.close(code, reason);
  } catch {
    // no-op
  }
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
    const userId = auth.userId;
    if (!userId) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const groupId = randomId();
    const ownerParticipantId = randomId();
    const ownerNameFromProfile = (auth.firstName ?? "").trim();
    const ownerName = ownerNameFromProfile || ownerEmail.split("@")[0]?.trim() || "Owner";

    const group: Group = {
      id: groupId,
      name,
      createdAt: new Date().toISOString(),
      ownerUserId: userId,
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
      return c.json({ error: await parseError(initResponse) }, initResponse.status as 400 | 500);
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
    const userId = auth.userId;
    if (!userId) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const groupIds = new Set<string>();

    const ownerKeys = await listAllKeys(c, `owner-group:${userId}:`);
    for (const key of ownerKeys) {
      const groupId = key.slice(`owner-group:${userId}:`.length);
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
        groups.push(JSON.parse(raw) as GroupIndexRecord);
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
  .get("/groups/:groupId/ws", async (c) => {
    const auth = await getAuthContext(c);

    const groupId = c.req.param("groupId");
    const viewer: GroupViewerIdentity = {
      userId: auth.isAuthenticated ? auth.userId : null,
      verifiedEmails: auth.verifiedEmails,
      primaryEmail: auth.primaryEmail,
      firstName: auth.firstName,
      lastName: auth.lastName,
    };

    const upstreamResponse = (await callDurableObject(groupStub(c, groupId), "/ws", {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        [VIEWER_HEADER]: encodeViewer(viewer),
      },
    })) as UpgradedResponse;

    if (upstreamResponse.status !== 101 || !upstreamResponse.webSocket) {
      return c.json(
        { error: await parseError(upstreamResponse) },
        upstreamResponse.status as 400 | 401 | 404 | 500,
      );
    }

    const WebSocketPairCtor = globalThis as unknown as {
      WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
    };
    const pair = new WebSocketPairCtor.WebSocketPair();
    const clientSocket = pair[0] as BridgeSocket;
    const workerSocket = pair[1] as BridgeSocket;
    const upstreamSocket = upstreamResponse.webSocket as BridgeSocket;

    workerSocket.accept();
    upstreamSocket.accept();

    workerSocket.addEventListener("message", (event) => {
      try {
        upstreamSocket.send(event.data);
      } catch {
        relayClose(workerSocket, upstreamSocket, 1011, "Proxy send failure");
      }
    });

    upstreamSocket.addEventListener("message", (event) => {
      const data = String(event.data);
      try {
        const parsed = JSON.parse(data) as GroupRealtimeServerMessage;
        void syncFromDoMessage(c, parsed);
      } catch {
        // Pass through malformed upstream payloads unchanged.
      }

      try {
        workerSocket.send(data);
      } catch {
        relayClose(workerSocket, upstreamSocket, 1011, "Proxy send failure");
      }
    });

    workerSocket.addEventListener("close", (event) => {
      relayClose(workerSocket, upstreamSocket, event.code, event.reason);
    });
    upstreamSocket.addEventListener("close", (event) => {
      relayClose(upstreamSocket, workerSocket, event.code, event.reason);
    });

    workerSocket.addEventListener("error", () => {
      relayClose(workerSocket, upstreamSocket, 1011, "Socket error");
    });
    upstreamSocket.addEventListener("error", () => {
      relayClose(upstreamSocket, workerSocket, 1011, "Socket error");
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    } as ResponseInit & { webSocket: WebSocket });
  });

export { groupsRoutes };
