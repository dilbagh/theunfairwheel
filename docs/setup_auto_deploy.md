# Setup Auto Deploy (GitHub -> Cloudflare)

This guide sets up continuous deployment (CD) for this repo:
- Frontend (`apps/web`) deploys to Cloudflare Pages.
- Backend (`apps/backend`) deploys to Cloudflare Workers.
- Deploy runs automatically on every push to the `main` branch.

## 1. What this pipeline does

When you push to `main`, GitHub Actions will:
1. Install dependencies.
2. Build the frontend with `VITE_API_URL` from GitHub Secrets.
3. Deploy `apps/web/dist` to Cloudflare Pages.
4. Deploy the Worker from `apps/backend/wrangler.jsonc`.
5. Set Worker `FRONTEND_URL` from GitHub Secrets for CORS.

## 2. Create Cloudflare resources (Dashboard)

You need one Pages project and one Worker.

### 2.1 Create (or confirm) a Pages project

1. Open Cloudflare Dashboard.
2. Go to `Workers & Pages`.
3. Click `Create application`.
4. Choose `Pages`.
5. Choose `Direct Upload` (this repo deploys from GitHub Actions, not Git integration).
6. Enter your project name (example: `theunfairwheel-web`).
7. Finish creation.

Save this project name. You will use it as `CLOUDFLARE_PAGES_PROJECT_NAME`.

### 2.2 Create (or confirm) a Worker

1. In Cloudflare Dashboard, go to `Workers & Pages`.
2. Click `Create application` -> `Workers`.
3. Create a Worker name (example: `theunfairwheel-backend`).
4. Keep defaults.

Note: GitHub Actions deploy uses Wrangler and can create/update from `apps/backend/wrangler.jsonc`.

### 2.3 Find your Cloudflare Account ID

1. In Cloudflare Dashboard, open any account page.
2. In the right sidebar (or account overview), find `Account ID`.
3. Copy it.

You will use it as `CLOUDFLARE_ACCOUNT_ID`.

## 3. Create a Cloudflare API Token

Create one token that can deploy both Pages and Worker.

1. Cloudflare Dashboard -> `My Profile` -> `API Tokens`.
2. Click `Create Token`.
3. Start from `Custom token`.
4. Add these permissions:
   - `Account` -> `Cloudflare Pages` -> `Edit`
   - `Account` -> `Workers Scripts` -> `Edit`
   - `Account` -> `Account Settings` -> `Read`
5. Optional permission (only if you later map custom Worker routes/domains):
   - `Zone` -> `Workers Routes` -> `Edit`
6. For `Account Resources`, include the account you deploy to.
7. For `Zone Resources`, include specific zones only if you added zone permissions.
8. Create token and copy it once.

You will use it as `CLOUDFLARE_API_TOKEN`.

## 4. Add GitHub repository secrets

In GitHub:
1. Open your repo.
2. Go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Click `New repository secret` and add the following.

Required secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT_NAME`
- `PROD_API_URL`
- `PROD_FRONTEND_URL`

Recommended value format:
- `PROD_FRONTEND_URL`: `https://<project>.pages.dev`
- `PROD_API_URL`: `https://<worker-name>.<subdomain>.workers.dev`

Example:
- `PROD_FRONTEND_URL=https://theunfairwheel-web.pages.dev`
- `PROD_API_URL=https://theunfairwheel-backend.<your-subdomain>.workers.dev`

## 5. One-time Cloudflare settings checklist

Before first production deploy, verify:
- Pages production branch is `main`.
- Pages project name exactly matches `CLOUDFLARE_PAGES_PROJECT_NAME`.
- Worker deploy succeeds manually at least once (optional but useful sanity check).
- `PROD_FRONTEND_URL` matches the frontend domain.
- `PROD_API_URL` matches the backend Worker public URL.

If you later move to custom domains:
1. Add custom domain in Pages.
2. Add Worker route/domain mapping in Cloudflare.
3. Update GitHub Secrets:
   - `PROD_FRONTEND_URL`
   - `PROD_API_URL`

## 6. GitHub Action used by this repo

Workflow file: `.github/workflows/deploy-cloudflare.yml`

It deploys on:
- `push` to `main`

It uses:
- `cloudflare/wrangler-action@v3.14.1` for Pages deployment
- `cloudflare/wrangler-action@v3.14.1` for Worker deployment
- `packageManager: npm` and `wranglerVersion: 4.44.0` in both steps to avoid pnpm workspace-root install errors in CI

`cloudflare/pages-action` is not used because it is deprecated.

## 7. Verify the pipeline

### 7.1 Trigger deployment

1. Push any commit to `main`.
2. Open GitHub repo -> `Actions` tab.
3. Open the latest `Deploy to Cloudflare` run.

### 7.2 Confirm frontend

1. Open your `https://<project>.pages.dev` URL.
2. Confirm latest UI changes are visible.

### 7.3 Confirm backend

1. Open `https://<worker-url>/health`.
2. Expect JSON response with `ok: true`.

### 7.4 Confirm CORS

From the deployed frontend, confirm API calls succeed without browser CORS errors.

## 8. Troubleshooting

### Error: Authentication / authorization failed

Likely cause:
- Wrong token value
- Missing token permissions

Fix:
1. Recreate token with required scopes.
2. Update `CLOUDFLARE_API_TOKEN` in GitHub Secrets.
3. Re-run workflow.

### Error: Could not find account

Likely cause:
- Wrong `CLOUDFLARE_ACCOUNT_ID`

Fix:
1. Copy account ID again from Cloudflare Dashboard.
2. Update secret.
3. Re-run workflow.

### Error: Pages project not found

Likely cause:
- Wrong `CLOUDFLARE_PAGES_PROJECT_NAME`

Fix:
1. Check exact project name in Cloudflare Pages.
2. Update secret.
3. Re-run workflow.

### Error: `ERR_PNPM_ADDING_TO_ROOT` in Wrangler step

Likely cause:
- Wrangler action attempted to install Wrangler using `pnpm` at workspace root.

Fix:
1. Keep workflow configured with `packageManager: npm` in Wrangler action steps.
2. Keep `wranglerVersion` pinned (currently `4.44.0`).
3. Re-run workflow.

### Frontend deployed but API calls fail

Likely cause:
- `PROD_API_URL` points to wrong Worker URL
- `PROD_FRONTEND_URL` does not match deployed frontend domain

Fix:
1. Verify Worker URL and Pages URL.
2. Update both secrets.
3. Push a new commit to redeploy frontend and Worker.
