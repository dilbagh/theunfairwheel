import {
  DEFAULT_GROUP_SETTINGS,
  randomId,
  type Group,
  type GroupSettings,
  type Participant,
  validateName,
} from "../domain/group";
import type { Bindings, DurableObjectStateLike } from "../types";

type GroupState = {
  group: Group;
  participants: Participant[];
};

type ErrorBody = {
  error: string;
};

const GROUP_STATE_KEY = "group-state";

export class GroupDurableObject {
  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly _env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/init") {
        const body = (await request.json()) as { group: Group };
        const groupName = validateName(body.group.name);

        const nextState: GroupState = {
          group: {
            ...body.group,
            name: groupName,
            settings: body.group.settings ?? DEFAULT_GROUP_SETTINGS,
          },
          participants: [],
        };

        await this.state.storage.put(GROUP_STATE_KEY, nextState);
        return Response.json(nextState.group, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/group") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        return Response.json(current.group);
      }

      if (request.method === "PATCH" && url.pathname === "/settings") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const body = (await request.json()) as Partial<GroupSettings>;
        if (typeof body.removeWinnerAfterSpin !== "boolean") {
          return this.error(400, "removeWinnerAfterSpin must be a boolean.");
        }

        current.group.settings = {
          removeWinnerAfterSpin: body.removeWinnerAfterSpin,
        };
        await this.saveState(current);

        return Response.json(current.group.settings);
      }

      if (request.method === "GET" && url.pathname === "/participants") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        return Response.json(current.participants);
      }

      if (request.method === "POST" && url.pathname === "/participants") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const body = (await request.json()) as { name?: string };
        const name = validateName(body.name ?? "");

        if (
          current.participants.some(
            (participant) => participant.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          return this.error(409, "Participant with this name already exists.");
        }

        const participant: Participant = {
          id: randomId(),
          name,
          active: true,
        };

        current.participants.push(participant);
        await this.saveState(current);

        return Response.json(participant, { status: 201 });
      }

      const participantsPathMatch = url.pathname.match(/^\/participants\/([^/]+)$/);
      if (participantsPathMatch && request.method === "PATCH") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const participantId = participantsPathMatch[1];
        const body = (await request.json()) as { active?: boolean };

        if (typeof body.active !== "boolean") {
          return this.error(400, "active must be a boolean.");
        }

        const participant = current.participants.find((item) => item.id === participantId);
        if (!participant) {
          return this.error(404, "Participant not found.");
        }

        participant.active = body.active;
        await this.saveState(current);

        return Response.json(participant);
      }

      if (participantsPathMatch && request.method === "DELETE") {
        const current = await this.loadState();
        if (!current) {
          return this.error(404, "Group not found.");
        }

        const participantId = participantsPathMatch[1];
        current.participants = current.participants.filter(
          (participant) => participant.id !== participantId,
        );
        await this.saveState(current);

        return new Response(null, { status: 204 });
      }

      return this.error(404, "Not found.");
    } catch (error) {
      if (error instanceof Error) {
        return this.error(400, error.message);
      }

      return this.error(500, "Internal server error.");
    }
  }

  private async loadState(): Promise<GroupState | null> {
    const data = await this.state.storage.get<GroupState>(GROUP_STATE_KEY);
    return data ?? null;
  }

  private async saveState(nextState: GroupState): Promise<void> {
    await this.state.storage.put(GROUP_STATE_KEY, nextState);
  }

  private error(status: number, message: string): Response {
    return Response.json({ error: message } satisfies ErrorBody, { status });
  }
}
