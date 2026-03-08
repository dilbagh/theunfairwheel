import { ApiError, type GroupRealtimeCommand, type GroupRealtimeServerMessage } from "./groups";

export type GroupRealtimeStatus = "connecting" | "reconnecting" | "open" | "closed";

type GroupRealtimeConnection = {
  close(): void;
  request(command: Omit<GroupRealtimeCommand, "requestId">): Promise<void>;
};

type ConnectGroupRealtimeInput = {
  groupId: string;
  getToken?: () => Promise<string | null>;
  onMessage: (message: GroupRealtimeServerMessage) => void;
  onStatusChange?: (status: GroupRealtimeStatus) => void;
};

type PendingRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function wsBaseUrl(): string {
  const apiBase = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function wsUrlForGroup(groupId: string, getToken?: () => Promise<string | null>): Promise<string> {
  const url = new URL(`${wsBaseUrl()}/groups/${encodeURIComponent(groupId)}/ws`);
  if (getToken) {
    const token = await getToken();
    if (token) {
      url.searchParams.set("token", token);
    }
  }

  return url.toString();
}

export function connectGroupRealtime(input: ConnectGroupRealtimeInput): GroupRealtimeConnection {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let isClosed = false;
  let isConnecting = false;
  const pendingRequests = new Map<string, PendingRequest>();

  const updateStatus = (status: GroupRealtimeStatus) => {
    input.onStatusChange?.(status);
  };

  const rejectPendingRequests = (message: string) => {
    for (const [requestId, pending] of pendingRequests.entries()) {
      pending.reject(new Error(message));
      pendingRequests.delete(requestId);
    }
  };

  const detachSocket = (target: WebSocket | null) => {
    if (!target) {
      return;
    }

    target.onopen = null;
    target.onmessage = null;
    target.onerror = null;
    target.onclose = null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (isClosed) {
      return;
    }

    reconnectAttempt += 1;
    updateStatus("reconnecting");

    const delayMs = Math.min(1000 * 2 ** Math.max(reconnectAttempt - 1, 0), 10000);
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (isClosed || isConnecting) {
      return;
    }

    isConnecting = true;
    updateStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

    try {
      const nextSocket = new WebSocket(await wsUrlForGroup(input.groupId, input.getToken));
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (isClosed || socket !== nextSocket) {
          nextSocket.close(1000, "Client closed");
          return;
        }

        reconnectAttempt = 0;
        isConnecting = false;
        updateStatus("open");
      };

      nextSocket.onmessage = (event) => {
        if (isClosed || socket !== nextSocket) {
          return;
        }

        try {
          const parsed = JSON.parse(String(event.data)) as GroupRealtimeServerMessage;
          if (!parsed || typeof parsed.type !== "string") {
            return;
          }

          if (parsed.type === "command.ok") {
            const pending = pendingRequests.get(parsed.payload.requestId);
            if (pending) {
              pending.resolve();
              pendingRequests.delete(parsed.payload.requestId);
            }
          } else if (parsed.type === "command.error") {
            const pending = pendingRequests.get(parsed.payload.requestId);
            if (pending) {
              pending.reject(new ApiError(parsed.payload.error, parsed.payload.status));
              pendingRequests.delete(parsed.payload.requestId);
            }
          }

          input.onMessage(parsed);
        } catch {
          // Ignore malformed server payloads.
        }
      };

      nextSocket.onerror = () => {
        if (socket !== nextSocket) {
          return;
        }

        nextSocket.close();
      };

      nextSocket.onclose = () => {
        if (socket === nextSocket) {
          socket = null;
        }

        isConnecting = false;
        rejectPendingRequests("Realtime connection closed.");

        if (isClosed) {
          updateStatus("closed");
          return;
        }

        scheduleReconnect();
      };
    } catch {
      isConnecting = false;
      scheduleReconnect();
    }
  };

  void connect();

  return {
    close() {
      if (isClosed) {
        return;
      }

      isClosed = true;
      clearReconnectTimer();
      rejectPendingRequests("Realtime connection closed.");
      const currentSocket = socket;
      socket = null;
      detachSocket(currentSocket);

      if (currentSocket) {
        currentSocket.close(1000, "Client closed");
      }

      updateStatus("closed");
    },

    async request(command) {
      if (isClosed) {
        throw new Error("Realtime connection closed.");
      }

      const requestId = crypto.randomUUID();
      const payload = {
        ...command,
        requestId,
      } as GroupRealtimeCommand;

      const send = () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error("Realtime connection unavailable.");
        }

        socket.send(JSON.stringify(payload));
      };

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Realtime connection unavailable.");
      }

      return new Promise<void>((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });

        try {
          send();
        } catch (error) {
          pendingRequests.delete(requestId);
          reject(error instanceof Error ? error : new Error("Failed to send socket command."));
        }
      });
    },
  };
}
