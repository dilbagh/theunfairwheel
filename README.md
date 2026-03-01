# The Unfair Wheel

The Unfair Wheel is a real-time, weighted random picker for teams.

It lets a group spin a wheel to pick a winner, while biasing odds toward participants who have not won recently. The app is built for repeated team rituals (standups, demos, retros, random assignments) where pure randomness can feel unfair over time.

## What the project does

- Creates private groups (authenticated with Clerk).
- Adds/removes/manages participants per group.
- Runs weighted spins:
  - Every active participant has a weight of `spinsSinceLastWon + 1`.
  - People who have not won recently get higher probability.
- Stores recent spin history (up to 20 entries).
- Streams real-time updates to all connected clients via WebSocket events from a Durable Object.
- Supports bookmarking groups per user.

## Tech stack

- Frontend: React + Vite + TanStack Router + React Query (`apps/web`)
- Backend API: Hono on Cloudflare Workers (`apps/backend`)
- Realtime/state: Cloudflare Durable Objects
- Metadata/indexing: Cloudflare KV
- Auth: Clerk
- Monorepo: pnpm workspaces + Turborepo

## Repository structure

- `apps/web`: browser app UI
- `apps/backend`: Cloudflare Worker API + Durable Object logic
- `packages/*`: shared lint/ts packages for the monorepo

## Prerequisites

- Node.js `>=18` (Node 20+ recommended)
- `pnpm` 9.x
- A Clerk application (publishable key + secret key)
- Cloudflare account (for KV namespace + Workers runtime in local dev)

## Local setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure frontend env

```bash
cp apps/web/.env.example apps/web/.env
```

Set values in `apps/web/.env`:

```env
VITE_API_URL=http://127.0.0.1:8787
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx
```

### 3. Configure backend env

```bash
cp apps/backend/.env.example apps/backend/.env
```

Set values in `apps/backend/.env`:

```env
FRONTEND_URL=http://localhost:3000
CLERK_SECRET_KEY=sk_test_xxx
```

### 4. Create KV namespaces and wire `wrangler.jsonc`

The backend depends on `GROUP_INDEX_KV`. Create namespaces (once):

```bash
pnpm dlx wrangler@4.44.0 kv namespace create GROUP_INDEX_KV
pnpm dlx wrangler@4.44.0 kv namespace create GROUP_INDEX_KV --preview
```

Copy the returned `id` and `preview_id` into `apps/backend/wrangler.jsonc`:

- Replace `REPLACE_WITH_KV_NAMESPACE_ID`
- Replace `REPLACE_WITH_KV_PREVIEW_ID`

### 5. Run apps locally

Run both apps together:

```bash
pnpm dev
```

Or run separately:

```bash
pnpm --filter @repo/backend dev
pnpm --filter @repo/web dev
```

Local URLs:

- Frontend: `http://localhost:3000`
- Backend: `http://127.0.0.1:8787`
- Health check: `http://127.0.0.1:8787/health`

## Useful scripts

From repo root:

```bash
pnpm dev
pnpm build
pnpm lint
pnpm check-types
pnpm format
```

## Deployment

GitHub Actions deploys:

- `apps/web` to Cloudflare Pages
- `apps/backend` to Cloudflare Workers

See deployment setup guide: `docs/setup_auto_deploy.md`.

## Notes on permissions and access

- Only authenticated users can create groups.
- Group managers can rename groups and manage participants.
- Group participants (or owner) can trigger spins and access history.
- Owner participant cannot be removed and remains a manager.
