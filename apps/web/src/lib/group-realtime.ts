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

  const updateStatus = (status: GroupRealtimeStatus) => {
    input.onStatusChange?.(status);
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
    reconnectTimer = window.setTimeout(connect, delayMs);
  };

  const connect = () => {
    if (isClosed) {
      return;
    }

    updateStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

    const nextSocket = new WebSocket(wsUrlForGroup(input.groupId));
    socket = nextSocket;

    nextSocket.onopen = () => {
      if (isClosed || socket !== nextSocket) {
        nextSocket.close(1000, "Client closed");
        return;
      }

      reconnectAttempt = 0;
      updateStatus("open");
    };

    nextSocket.onmessage = (event) => {
      if (isClosed || socket !== nextSocket) {
        return;
      }

      try {
        const parsed = JSON.parse(String(event.data)) as GroupRealtimeEvent;
        if (parsed && typeof parsed.type === "string") {
          input.onEvent(parsed);
        }
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

      if (isClosed) {
        updateStatus("closed");
        return;
      }

      scheduleReconnect();
    };
  };

  connect();

  return {
    close() {
      if (isClosed) {
        return;
      }

      isClosed = true;
      clearReconnectTimer();
      const currentSocket = socket;
      socket = null;
      detachSocket(currentSocket);

      if (currentSocket) {
        currentSocket.close(1000, "Client closed");
      }

      updateStatus("closed");
    },
  };
}
