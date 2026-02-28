import { Hono } from "hono";
import { cors } from "hono/cors";
import { groupsRoutes } from "./routes/groups";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.use("/*", (c, next) => {
  const frontendUrl = c.env.FRONTEND_URL;
  return cors({
    origin: frontendUrl,
    allowHeaders: ["Content-Type", "Authorization"],
  })(c, next);
});

const routes = app
  .get("/health", (c) => {
    return c.json({
      ok: true,
      service: "backend",
      timestamp: new Date().toISOString(),
    });
  })
  .route("/", groupsRoutes);

export { app, routes };
