import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  FRONTEND_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", (c, next) => {
  const frontendUrl = c.env.FRONTEND_URL;
  return cors({ origin: frontendUrl })(c, next);
});

export const routes = app.get("/health", (c) => {
  return c.json({
    ok: true,
    service: "backend",
    timestamp: new Date().toISOString(),
  });
});

export type AppType = typeof routes;

export default app;
