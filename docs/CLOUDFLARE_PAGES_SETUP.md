# Connect DCAT to Cloudflare Pages

This project can be deployed either as **Cloudflare Pages advanced mode** or as a **Workers Builds** project. Both use the same build: `npm run build:pages` emits `apps/web/dist/_worker.js`, which serves the same-origin `/api/*` routes and delegates other requests to the asset binding.

Do **not** deploy only `npm run build:hosted`; that output has no `_worker.js` and `/api/*` will 404.

The root `wrangler.jsonc` has two jobs: it stops Cloudflare from running Wrangler autoconfiguration at the npm workspace root, and for Workers Builds it is the deploy config used by `npx wrangler deploy`. If **Create application** only leads to Workers, open the direct Pages URL: `https://dash.cloudflare.com/<account-id>/workers-and-pages/create/pages`. Otherwise use the **Workers Builds** section below; it keeps the same local-first behavior and security headers.

## Before you start

- Repository: `https://github.com/herethesavior/data-cloud-architect-toolkit.git`
- Production branch: `main`
- Node.js 22.12+ (set `NODE_VERSION=22.12.0`)
- A Cloudflare KV namespace bound as `DCAT_SESSIONS` (for Workers Builds, its id goes in the root `wrangler.jsonc`)
- For hosted live-org connections: `@dcat-toolkit/bridge` is published publicly at `@latest` (Demo mode works without it)

There are **no OAuth settings, client secrets, callback URLs, or token encryption keys** to configure.

## Workers Builds (when the dashboard only offers “Create application”)

Use this path if the setup screen says **Configure your Worker project** and shows a deploy command.

1. Create a KV namespace:

   ```bash
   npx wrangler kv namespace create DCAT_SESSIONS
   ```

   Put the returned `id` into the `kv_namespaces` entry in the root `wrangler.jsonc`:

   ```jsonc
   "kv_namespaces": [
     {
       "binding": "DCAT_SESSIONS",
       "id": "<production-namespace-id>",
       "preview_id": "<preview-namespace-id>"
     }
   ]
   ```

2. In the Cloudflare setup screen, use:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | blank |
   | Build command | `npm install && npm run build:pages` |
   | Deploy command | `npx wrangler deploy` |
   | `NODE_VERSION` | `22.12.0` |

3. Preview builds may stay enabled: the root config includes a separate `preview_id` for preview sessions.

The deploy command bundles `apps/hosted-worker/src/pages.ts` from the root config and serves `apps/web/dist` as assets. It does not depend on the generated `_worker.js`, so a plain `npm run build` is enough to produce the assets. The root config runs the Worker before assets for every route so security headers apply to both API and SPA responses.

## 1. Bridge package

`@dcat-toolkit/bridge` is published publicly, and the hosted wizard uses `npx -y @dcat-toolkit/bridge@latest ...`. No npm credentials or publish step are needed to deploy the Pages site.

For a future release, bump the version on `main`, push the commit, then push a matching tag:

```bash
npm version patch --workspace @dcat-toolkit/bridge
git add packages/bridge/package.json package-lock.json
git commit -m "chore: release bridge 0.1.7"
git push origin main
git tag bridge-v0.1.7
git push origin bridge-v0.1.7
npm view @dcat-toolkit/bridge version
```

The tag runs `.github/workflows/publish-bridge.yml`. It checks that the tag matches `packages/bridge/package.json`, runs the full checks, builds the bridge, and runs `npm stage publish --tag latest` with npm trusted publishing (OIDC). Configure the trusted publisher for `herethesavior/data-cloud-architect-toolkit`, workflow `publish-bridge.yml`, environment `npm-bridge`, allowing **npm stage publish** only — not `npm publish` or `npm dist-tag`. No npm token is needed or stored in GitHub. Review and approve the staged version under **Account > Staged Packages** with 2FA; only then does `@latest` move. `prepack` bundles `packages/bridge/dist/bridge.mjs` from source, so the staged tarball is reproducible from the tag.

## 2. Create the KV namespace

In the Cloudflare dashboard:

1. Go to **Workers & Pages** > **KV**.
2. Select **Create namespace**.
3. Name it, for example, `dcat-sessions-production`.
4. Optionally create a second namespace for preview deployments.

Or use Wrangler after `npx wrangler login`:

```bash
npx wrangler kv namespace create DCAT_SESSIONS
```

Record the namespace id or note the namespace name; you will select it in the Pages binding step. The id is not needed in the repository for the Pages deployment.

## 3. Connect the GitHub repository

1. Go directly to `https://dash.cloudflare.com/<account-id>/workers-and-pages/create/pages`, or use **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
2. Choose **GitHub** and authorize Cloudflare for the repository.
3. Select `herethesavior/data-cloud-architect-toolkit`, then **Install & Authorize** > **Begin setup**.
4. Configure the project:

   | Setting | Value |
   | --- | --- |
   | Project name | `sfdcat` (or your preferred name) |
   | Production branch | `main` |
   | Framework preset | **None** |
   | Root directory | Leave blank (repository root) |
   | Build command | `npm install && npm run build:pages` |
   | Build output directory | `apps/web/dist` |
   | `NODE_VERSION` | `22.12.0` (or newer 22.x/24.x) |
   | Compatibility date | `2026-11-18` (also set under **Settings** > **Runtime** after project creation) |
   | Wrangler config | Keep the committed root `wrangler.jsonc`; do not remove it to trigger autoconfig |

5. Select **Save and Deploy**.

The build runs the root TypeScript check, builds the hosted Vite bundle, and bundles the API Worker into `apps/web/dist/_worker.js`. It also writes `apps/web/dist/.assetsignore` so server code is not exposed as a public static asset; Pages still uses `_worker.js` as the advanced-mode function.

## 4. Bind KV to the Pages project

1. Open the new Pages project.
2. Go to **Settings** > **Bindings** > **Add** > **KV namespace**.
3. Set **Variable name** to exactly `DCAT_SESSIONS`.
4. Select the namespace created in step 2.
5. Save the binding. Repeat for the Preview environment if you use preview deployments.
6. Redeploy the project so the binding is picked up.

Do not put the namespace id in `apps/hosted-worker/wrangler.jsonc` for the Pages path. That file is for the optional standalone Worker workflow (`npm run worker:dev` / `npm run worker:deploy`); a direct Worker deploy does require its `id` field.

## 5. Verify the live deployment

Open the Cloudflare-provided URL (for example, `https://sfdcat.pages.dev`).

- The workbench loads and Demo mode is clearly labelled.
- `GET /api/health` returns JSON with `"status":"ok"`.
- `GET /api/session` returns a CSRF token and sets the `dcat_session` cookie.
- `GET /api/auth/login` returns `404` (hosted OAuth is removed).
- API responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- **Connect an org** shows the three-step **Set up SF CLI** → **Connect org** → **View inventory** wizard and a pairing command using the deployed origin.

For a local rehearsal of the Pages runtime before deploying:

```bash
npm run pages:dev
```

This builds the SPA plus `_worker.js` and serves them with `wrangler pages dev` on `http://127.0.0.1:8788` with a local `DCAT_SESSIONS` KV binding.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npx wrangler deploy` says `DCAT_SESSIONS` needs an `id` | The Workers Builds config has the binding but no real namespace id. | Create the KV namespace and set its `id` in the root `wrangler.jsonc`, then retry. |
| `npx wrangler deploy` says the entry-point file is missing | The build command did not run `npm run build:pages`. | Set Build command to `npm install && npm run build:pages`. |
| Wrangler says application detection ran in the root of a workspace | The committed root `wrangler.jsonc` is missing, so Cloudflare tries to autoconfig the monorepo root. | Restore the root `wrangler.jsonc` and redeploy; keep Root directory blank. |
| `/api/*` returns 404 or the SPA appears but has no data | Build output came from `npm run build:hosted` and has no `_worker.js`. | Use build command `npm install && npm run build:pages`. |
| API returns a 500 about `DCAT_SESSIONS` | Pages KV binding is missing or named differently. | Add a KV binding named exactly `DCAT_SESSIONS`, then redeploy. |
| CSRF errors after a redeploy | The browser cookie points at session state in another KV namespace. | Refresh the page; if needed, clear site data. |
| Pairing command fails with npm 404 | npm is unreachable, or the command names a different package than the published one. | Run `npm view @dcat-toolkit/bridge version`; republish under the configured name if needed. |
| Bridge stays “waiting” | The agent is stopped, offline, or paired with a different browser session. | Restart with the printed command or create a fresh pairing code. |
| Live org shows capability warnings | The org lacks Data 360 provisioning or permissions. | Treat warnings as explicit unsupported/forbidden states, not empty data. |

Optional: add a custom domain under **Settings** > **Custom domains** once the Pages deployment is healthy.
