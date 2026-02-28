import type { AppType } from "@repo/backend";
import { hc } from "hono/client";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";

export const apiClient = hc<AppType>(baseUrl);
