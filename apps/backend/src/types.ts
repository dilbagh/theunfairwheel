export type DurableObjectStorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

export type DurableObjectStateLike = {
  storage: DurableObjectStorageLike;
};

export type DurableObjectStubLike = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type DurableObjectIdLike = object;

export type DurableObjectNamespaceLike = {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
};

export type KvKey = {
  name: string;
};

export type KvListResult = {
  keys: KvKey[];
  list_complete: boolean;
  cursor?: string;
};

export type KvNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KvListResult>;
};

export type Bindings = {
  FRONTEND_URL: string;
  CLERK_SECRET_KEY: string;
  GROUPS_DO: DurableObjectNamespaceLike;
  GROUP_INDEX_KV: KvNamespaceLike;
};

export type AppEnv = {
  Bindings: Bindings;
};
