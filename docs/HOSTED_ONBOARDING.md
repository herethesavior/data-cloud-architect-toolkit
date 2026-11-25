# Hosted bridge onboarding and deployment

The hosted DCAT site is a React SPA served by a Cloudflare Worker with static assets. The Worker serves the session, mode, health, and labelled demo fixtures, and relays typed operations to a small outbound agent running on the user's machine. Hot relay state is SQLite storage in one Durable Object per paired bridge. There is no hosted Salesforce OAuth: `/api/auth/*` paths are removed and return 404, DCAT collects no Salesforce credentials, and the Worker needs no OAuth secrets or token encryption key.

## Deploy

Workers Builds is the preferred live path because the root `wrangler.jsonc` exports `RelaySessionDO` and binds it directly. Pages advanced mode also works: `npm run build:pages` builds `apps/web/dist/_worker.js`, and the Pages project binds `RELAY_DO` to the `RelaySessionDO` namespace exported by a deployed Worker. Both serve the SPA and same-origin `/api/*` requests.

1. **Create a KV namespace** for browser sessions and one-time pairing codes. In the Cloudflare dashboard, use **Workers & Pages > KV > Create namespace**, or run `npx wrangler kv namespace create DCAT_SESSIONS`. Relay state does not belong in KV.
2. **Connect the GitHub repository** with build command `npm install && npm run build:pages`, build output `apps/web/dist`, root directory blank, and `NODE_VERSION=22.12.0`. The production branch is `main`. Set the deploy command to `npx wrangler deploy`. Workers Builds publishes the Worker that exports `RelaySessionDO`; for a Pages-only deployment, run `npx wrangler deploy --config wrangler.jsonc` once to publish it.
3. **Bind both resources** with variable names exactly `DCAT_SESSIONS` and `RELAY_DO`. Workers Builds reads both from the root `wrangler.jsonc`. For Pages, add both bindings to each environment that serves the live bridge; `RELAY_DO` must point at the `RelaySessionDO` namespace exported by the Worker from step 2. Then redeploy.
4. **Verify** that `/api/health` returns JSON without a session cookie, `/api/auth/login` returns 404, and Demo mode is clearly labelled. See [CLOUDFLARE_PAGES_SETUP.md](CLOUDFLARE_PAGES_SETUP.md) for the full walkthrough and troubleshooting table.

The root `wrangler.jsonc` is the Workers Builds deploy config and contains the `DCAT_SESSIONS` namespace id. The separate standalone Worker path uses `npm run worker:dry-run`, `npm run worker:dev`, and `npm run worker:deploy`; it needs the namespace `id` in `apps/hosted-worker/wrangler.jsonc`. There are no other stores or secrets. Free KV allows 100,000 reads, 1,000 writes, 1,000 deletes, and 1,000 list requests per day with 1 GB storage, so agent polling uses the Durable Object instead. `SESSION_TTL_SECONDS` is optional (default 30 days); for local Worker development, copy `apps/hosted-worker/.dev.vars.example` to `.dev.vars` and never commit it.

As an operational guardrail, add Cloudflare KV metrics alerts for the `DCAT_SESSIONS` namespace at 20,000 daily reads, 500 daily writes, and 500 daily deletes. Those thresholds are far below the Free caps and should normally stay quiet. A test in `apps/hosted-worker/src/worker.test.ts` fails if agent polling performs any KV operation.

> Demo mode is live as soon as Cloudflare deploys. The hosted **Connect org** wizard uses the published `@dcat-toolkit/bridge` package at `@latest`, so no npm credentials or publish step are needed for deployment.

No Salesforce app registration, callback URL, consumer key/secret, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`, `TOKEN_ENCRYPTION_KEY`, or `SF_LOGIN_URL` is part of this deployment.

## User flow

1. The user opens the site; the Worker creates or resumes a browser session (`GET /api/session`) with an HttpOnly, Secure, SameSite cookie and a CSRF token.
2. Demo mode uses labelled Worker fixtures and bypasses the relay: all six capabilities are available, warnings are `[]`, and transform detail/lineage/run/schedule fixtures are complete.
3. For Live mode, the user opens **Connect an org**:
   - **Step 1 — Set up SF CLI.** The site shows a one-time pairing code and command. On the machine that will talk to Salesforce, run:

     ```bash
     npx -y @dcat-toolkit/bridge@latest setup --relay <site-url> --code <code>
     ```

     The installer installs Salesforce CLI if needed, pairs this browser session, and starts the bridge immediately. Later restarts use `npx -y @dcat-toolkit/bridge@latest start` with saved config. Bridge storage holds only the relay URL, token, and version (mode `600`), never credentials. If a newer npm release exists, Step 1 shows a copyable `npm install -g @dcat-toolkit/bridge@latest` command to run on the bridge machine.
   - **Step 2 — Connect org.** Enter a local alias and an optional HTTPS sandbox instance URL. The bridge runs the fixed `sf org login web --alias <alias> --set-default [--instance-url <https Salesforce URL>]` command locally; Salesforce CLI opens the browser for login.
   - **Step 3 — View inventory.** Select the authenticated org in the site; the browser sends typed requests through the Worker relay and the agent returns redacted results.
4. The agent long-polls `/api/relay/poll` with an agent token and answers via `/api/relay/respond`; a queued operation wakes the idle poll immediately instead of waiting for the next interval. Long operations show a **Working** state instead of a false offline warning because the bridge cannot poll while it is executing. Only `cli.status`, `org.list`, `org.connect`, `inventory.get`, `inventory.start`, `inventory.status`, `transform.get`, `mode.set`, and `bridge.update` are allowed. No arbitrary URL, command, shell, SOQL, or record data crosses the relay.
5. Unpairing invalidates the previous agent token in the Durable Object and the session. Creating a new pairing code requires unpairing first. Results are retained until the next operation and are capped at 5 MiB. DCAT never receives a username, password, security token, or SFDX auth URL.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Pairing code expired | Codes are one-time and short-lived. | Create a new code in Step 1 and rerun the `setup` command with it. |
| Bridge already paired | This browser still has an active agent token. | On **Connect org**, choose **Create new pairing code**; the button unpairs first, then rerun `setup` with the new code. |
| Bridge offline / "waiting for bridge" | The agent stopped, the machine is offline or asleep, or the relay URL is wrong. Settings shows a stale warning about a minute after the last check-in. | Restart with `npx -y @dcat-toolkit/bridge@latest start` and check network access. After repeated stale status, **Connect org** offers **Create new pairing code**, which unpairs first. |
| Bridge status unavailable | The site could not read the relay state for this pairing. | Use **Refresh status** to retry. If it stays unavailable, choose **Create new pairing code** in **Connect org**, then rerun the `setup` command shown. This resets the old pairing. |
| CLI missing | Salesforce CLI is not installed on the agent machine. | Re-run the `setup` command (it installs SF CLI if needed), then wait for the next agent check-in or use **Refresh status**. |
| Browser login never completes | The Salesforce CLI login window was closed, sandbox URL was wrong, or login was not finished. | Re-run Step 2 with a valid alias and HTTPS instance URL, complete login in the CLI-opened browser window, then refresh the org list. |
| Inventory unavailable / capability warnings | The org lacks Data 360 provisioning or permissions, or endpoints are unsupported. | DCAT reports unsupported/forbidden families explicitly. Check Data 360 access in the target org; do not treat these as empty results. |
| Removed OAuth URL returns 404 | `/api/auth/*` paths no longer exist. | Use the local bridge pairing flow above. |

Demo mode and Live mode labels are explicit throughout; if fixture data appears under Live, switch modes to clear the workspace context before continuing.
