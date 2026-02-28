export const STORAGE_KEYS = {
  lastGroupId: "uw:last-group-id",
  groups: "uw:groups",
  audioMuted: "uw:audio-muted",
} as const;

export function participantsKey(groupId: string) {
  return `uw:group-participants:${groupId}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getItem(key: string): string | null {
  return getStorage()?.getItem(key) ?? null;
}

export function setItem(key: string, value: string): void {
  getStorage()?.setItem(key, value);
}

export function removeItem(key: string): void {
  getStorage()?.removeItem(key);
}

export function getJSON<T>(key: string, fallback: T): T {
  const value = getItem(key);

  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function setJSON<T>(key: string, value: T): void {
  setItem(key, JSON.stringify(value));
}

export function getLastGroupId(): string | null {
  return getItem(STORAGE_KEYS.lastGroupId);
}

export function setLastGroupId(groupId: string): void {
  setItem(STORAGE_KEYS.lastGroupId, groupId);
}

export function getAudioMuted(): boolean {
  return getItem(STORAGE_KEYS.audioMuted) === "true";
}

export function setAudioMuted(muted: boolean): void {
  setItem(STORAGE_KEYS.audioMuted, String(muted));
}
