import { Hono } from "hono";
import { validator } from "hono/validator";
import {
  randomId,
  type Group,
  type GroupIndexRecord,
  validateName,
} from "../domain/group";
import type { AppEnv, DurableObjectStubLike } from "../types";

type ErrorBody = {
  error: string;
};

const createGroupBody = validator("json", (value) => value as { name?: string });
const addParticipantBody = validator("json", (value) => value as { name?: string });
const updateParticipantBody = validator("json", (value) => value as { active?: boolean });

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

const groupsRoutes = new Hono<AppEnv>()
  .post("/groups", createGroupBody, async (c) => {
    const body = c.req.valid("json");
    const name = validateName(body.name ?? "");
    const groupId = randomId();

    const group: Group = {
      id: groupId,
      name,
      createdAt: new Date().toISOString(),
    };

    const stub = groupStub(c, group.id);
    const initResponse = await callDurableObject(stub, "/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group }),
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
    };
    await c.env.GROUP_INDEX_KV.put(`group:${group.id}`, JSON.stringify(indexRecord));

    return c.json(group, 201);
  })
  .get("/groups/:groupId", async (c) => {
    const groupId = c.req.param("groupId");
    const response = await callDurableObject(groupStub(c, groupId), "/group");

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    return c.json(await response.json());
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

    return c.json(await response.json(), 201);
  })
  .patch("/groups/:groupId/participants/:participantId", updateParticipantBody, async (c) => {
    const groupId = c.req.param("groupId");
    const participantId = c.req.param("participantId");
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

    return c.json(await response.json());
  })
  .delete("/groups/:groupId/participants/:participantId", async (c) => {
    const groupId = c.req.param("groupId");
    const participantId = c.req.param("participantId");

    const response = await callDurableObject(
      groupStub(c, groupId),
      `/participants/${participantId}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      return c.json({ error: await parseError(response) }, response.status as 404 | 500);
    }

    return c.body(null, 204);
  });

export { groupsRoutes };
