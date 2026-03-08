import { app, routes } from "./app";

export { GroupDurableObject } from "./durable/group-do";
export type { Group, Participant } from "./domain/group";
export type {
  GroupRealtimeCommand,
  GroupRealtimeEvent,
  GroupRealtimeServerMessage,
  GroupSocketSnapshot,
  GroupSpinState,
  GroupViewerAccess,
  GroupViewerIdentity,
  SpinHistoryItem,
} from "./domain/realtime";
export type { Bindings } from "./types";

export type AppType = typeof routes;

export default app;
