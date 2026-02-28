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

export type KvNamespaceLike = {
  put(key: string, value: string): Promise<void>;
};

export type Bindings = {
  FRONTEND_URL: string;
  GROUPS_DO: DurableObjectNamespaceLike;
  GROUP_INDEX_KV: KvNamespaceLike;
};

export type AppEnv = {
  Bindings: Bindings;
};
