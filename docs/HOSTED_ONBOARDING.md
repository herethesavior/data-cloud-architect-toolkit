# Hosted bridge onboarding and deployment

The hosted DCAT site is a static React SPA served by Cloudflare Pages (or another static host). A Cloudflare Worker on the same origin serves the session, mode, health, and labelled demo fixtures, and relays typed operations to a small outbound agent running on the user's machine. There is no hosted Salesforce OAuth: `/api/auth/*` paths are removed and return 404, DCAT collects no Salesforce credentials, and the Worker needs no OAuth secrets or token encryption key.

## Deploy

The supported live path is one Cloudflare Pages project or one Workers Builds project. `npm run build:pages` builds `apps/web/dist` and writes a `_worker.js` into that output directory. Pages serves that Worker automatically; Workers Builds deploys it with the root `wrangler.jsonc` and `npx wrangler deploy`. Both paths serve the SPA and send same-origin `/api/*` requests to the Worker.

1. **Create a KV namespace** for browser sessions, one-time pairing codes, and relay state. In the Cloudflare dashboard, use **Workers & Pages > KV > Create namespace**, or run `npx wrangler kv namespace create DCAT_SESSIONS`.
2. **Connect the GitHub repository** with build command `npm install && npm run build:pages`, build output `apps/web/dist`, root directory blank, and `NODE_VERSION=22.12.0`. The production branch is `main`. For Workers Builds, also set the deploy command to `npx wrangler deploy`.
3. **Bind the KV namespace** with variable name exactly `DCAT_SESSIONS`. Pages binds it in the dashboard; Workers Builds needs the namespace `id` in the root `wrangler.jsonc`. Then redeploy.
4. **Verify** that `/api/health` returns JSON, `/api/auth/login` returns 404, and Demo mode is clearly labelled. See [CLOUDFLARE_PAGES_SETUP.md](CLOUDFLARE_PAGES_SETUP.md) for the full walkthrough and troubleshooting table.

The root `wrangler.jsonc` is the Workers Builds deploy config and contains the `DCAT_SESSIONS` namespace id. The separate standalone Worker path uses `npm run worker:dry-run`, `npm run worker:dev`, and `npm run worker:deploy`; it needs the namespace `id` in `apps/hosted-worker/wrangler.jsonc`. There are no other stores or secrets. KV writes are throttled to stay within free-tier limits. `SESSION_TTL_SECONDS` is optional (default 30 days); for local Worker development, copy `apps/hosted-worker/.dev.vars.example` to `.dev.vars` and never commit it.

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

     The installer installs Salesforce CLI if needed, pairs this browser session, and starts the bridge immediately. Later restarts use `npx -y @dcat-toolkit/bridge@latest start` with saved config. Bridge storage holds only the relay URL, token, and version (mode `600`), never credentials. If a newer npm release exists, Step 1 shows **Update bridge** for 0.1.4+ agents; older agents show a fixed copyable install command.
   - **Step 2 — Connect org.** Enter a local alias and an optional HTTPS sandbox instance URL. The bridge runs the fixed `sf org login web --alias <alias> --set-default [--instance-url <https Salesforce URL>]` command locally; Salesforce CLI opens the browser for login.
   - **Step 3 — View inventory.** Select the authenticated org in the site; the browser sends typed requests through the Worker relay and the agent returns redacted results.
4. The agent polls `/api/relay/poll` with an agent token and answers via `/api/relay/respond`. Only `cli.status`, `org.list`, `org.connect`, `inventory.get`, `transform.get`, `mode.set`, and `bridge.update` are allowed. No arbitrary URL, command, shell, SOQL, or record data crosses the relay.
5. Unpairing (or creating a new pairing code) invalidates the previous agent token. DCAT never receives a username, password, security token, or SFDX auth URL.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Pairing code expired | Codes are one-time and short-lived. | Create a new code in Step 1 and rerun the `setup` command with it. |
| Bridge not paired / already paired | The code was consumed elsewhere, or this browser still has an agent. | Create a new code (this replaces the old pairing), or unpair before pairing again. |
| Bridge offline / "waiting for bridge" | The agent stopped, the machine is offline, or the relay URL is wrong. | Restart with `npx -y @dcat-toolkit/bridge@latest start`, check network access to the site, or re-run `setup` with a fresh code. |
| CLI missing | Salesforce CLI is not installed on the agent machine. | Re-run the `setup` command (it installs SF CLI if needed), then use **Re-check CLI**. |
| Browser login never completes | The Salesforce CLI login window was closed, sandbox URL was wrong, or login was not finished. | Re-run Step 2 with a valid alias and HTTPS instance URL, complete login in the CLI-opened browser window, then refresh the org list. |
| Inventory unavailable / capability warnings | The org lacks Data 360 provisioning or permissions, or endpoints are unsupported. | DCAT reports unsupported/forbidden families explicitly. Check Data 360 access in the target org; do not treat these as empty results. |
| Removed OAuth URL returns 404 | `/api/auth/*` paths no longer exist. | Use the local bridge pairing flow above. |

Demo mode and Live mode labels are explicit throughout; if fixture data appears under Live, switch modes to clear the workspace context before continuing.
