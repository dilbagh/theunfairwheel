import type { GroupRealtimeEvent } from "./groups";

export type GroupRealtimeStatus = "connecting" | "reconnecting" | "open" | "closed";

type GroupRealtimeConnection = {
  close(): void;
};

type ConnectGroupRealtimeInput = {
  groupId: string;
  onEvent: (event: GroupRealtimeEvent) => void;
  onStatusChange?: (status: GroupRealtimeStatus) => void;
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

function wsUrlForGroup(groupId: string): string {
  return `${wsBaseUrl()}/groups/${encodeURIComponent(groupId)}/ws`;
}

export function connectGroupRealtime(input: ConnectGroupRealtimeInput): GroupRealtimeConnection {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let isClosed = false;

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
    input.onStatusChange?.("reconnecting");

    const delayMs = Math.min(1000 * 2 ** Math.max(reconnectAttempt - 1, 0), 10000);
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(connect, delayMs);
  };

  const connect = () => {
    if (isClosed) {
      return;
    }

    input.onStatusChange?.(reconnectAttempt > 0 ? "reconnecting" : "connecting");

    socket = new WebSocket(wsUrlForGroup(input.groupId));

    socket.onopen = () => {
      reconnectAttempt = 0;
      input.onStatusChange?.("open");
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as GroupRealtimeEvent;
        if (parsed && typeof parsed.type === "string") {
          input.onEvent(parsed);
        }
      } catch {
        // Ignore malformed server payloads.
      }
    };

    socket.onerror = () => {
      socket?.close();
    };

    socket.onclose = () => {
      socket = null;
      if (isClosed) {
        input.onStatusChange?.("closed");
        return;
      }

      scheduleReconnect();
    };
  };

  connect();

  return {
    close() {
      isClosed = true;
      clearReconnectTimer();

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "Client closed");
      } else {
        socket?.close();
      }

      socket = null;
      input.onStatusChange?.("closed");
    },
  };
}
