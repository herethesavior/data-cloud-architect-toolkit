# Connect DCAT to Cloudflare Pages

The supported production deployment is **Workers Builds** with static assets. The root `wrangler.jsonc` deploys `apps/hosted-worker/src/worker-entry.ts`, which exports both the asset-aware Worker and the SQLite-backed `RelaySessionDO`. `npm run build:pages` still emits `apps/web/dist/_worker.js` for static previews, but Pages advanced mode cannot host the Durable Object class needed by the live bridge.

Do **not** deploy only `npm run build:hosted`; that output has no `_worker.js`, and a direct static deploy has no `/api/*` routes.

The root `wrangler.jsonc` stops Wrangler autoconfiguration at the npm workspace root and is the Workers Builds deploy config used by `npx wrangler deploy`.

## Before you start

- Repository: `https://github.com/herethesavior/data-cloud-architect-toolkit.git`
- Production branch: `main`
- Node.js 22.12+ (set `NODE_VERSION=22.12.0`)
- A Cloudflare KV namespace bound as `DCAT_SESSIONS` (for Workers Builds, its id goes in the root `wrangler.jsonc`)
- A `RELAY_DO` binding to the `RelaySessionDO` SQLite class, declared in the root `wrangler.jsonc`
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

The deploy command bundles `apps/hosted-worker/src/worker-entry.ts` from the root config and serves `apps/web/dist` as assets. It does not depend on the generated `_worker.js`, so `npm run build:hosted` is enough to produce the assets. The root config runs the Worker before assets for every route so security headers apply to both API and SPA responses.

> Pages advanced mode remains usable for Demo-only previews with a `DCAT_SESSIONS` binding, but it has no Durable Object binding. Use Workers Builds whenever the hosted live bridge is required.

## 1. Bridge package

`@dcat-toolkit/bridge` is published publicly, and the hosted wizard uses `npx -y @dcat-toolkit/bridge@latest ...`. No npm credentials or publish step are needed to deploy the Pages site.

For a future release, bump the version on `main`, push the commit, then push a matching tag:

```bash
npm version patch --workspace @dcat-toolkit/bridge --no-git-tag-version
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

For a local rehearsal of the hosted Worker before deploying:

```bash
npm run pages:dev
```

This builds the SPA and serves the standalone Worker config with local `DCAT_SESSIONS` KV and `RELAY_DO` Durable Object bindings on `http://127.0.0.1:8788`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npx wrangler deploy` says `DCAT_SESSIONS` needs an `id` | The Workers Builds config has the binding but no real namespace id. | Create the KV namespace and set its `id` in the root `wrangler.jsonc`, then retry. |
| `npx wrangler deploy` says the entry-point file is missing | The committed root `wrangler.jsonc` was removed or changed. | Restore the root config; the entry point is source code and does not depend on the build command. |
| Wrangler says application detection ran in the root of a workspace | The committed root `wrangler.jsonc` is missing, so Cloudflare tries to autoconfig the monorepo root. | Restore the root `wrangler.jsonc` and redeploy; keep Root directory blank. |
| `/api/*` returns 404 on a static-only host | No Worker is serving the SPA origin. | Deploy with Workers Builds using the root `wrangler.jsonc`. |
| API returns a 500 about `DCAT_SESSIONS` | KV binding is missing or named differently. | Add a KV binding named exactly `DCAT_SESSIONS`, then redeploy. |
| Relay requests fail with a missing `RELAY_DO` binding | The deployed config does not declare the Durable Object. | Add the `durable_objects` binding and `exports` block from the root `wrangler.jsonc`, then redeploy. |
| CSRF errors after a redeploy | The browser cookie points at session state in another KV namespace. | Refresh the page; if needed, clear site data. |
| Pairing command fails with npm 404 | npm is unreachable, or the command names a different package than the published one. | Run `npm view @dcat-toolkit/bridge version`; republish under the configured name if needed. |
| Bridge shows “Offline” after about a minute | The agent stopped, is offline or asleep, or its pairing was revoked. | Restart with the printed command and check network access. If it still fails after repeated stale status, use **Create new pairing code** on **Connect org**, which unpairs first. |
| Live org shows capability warnings | The org lacks Data 360 provisioning or permissions. | Treat warnings as explicit unsupported/forbidden states, not empty data. |

Optional: add a custom domain under **Settings** > **Custom domains** once the Pages deployment is healthy.
