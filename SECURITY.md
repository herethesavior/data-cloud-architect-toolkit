# Security Policy and Trust Model

DCAT has two editions with different trust boundaries. The default local CLI edition keeps its security boundary in the loopback Node connector. The hosted edition splits the boundary: a Cloudflare Worker holds only browser session and relay state, while a local outbound agent runs Salesforce CLI on the user's machine. Neither edition hosts OAuth or accepts Salesforce credentials.

## Local CLI edition (default)

- **Loopback binding.** The Fastify connector binds to `127.0.0.1` only. It must not be exposed on `0.0.0.0`, a LAN interface, or a tunnel.
- **Same origin.** In normal use, the UI and `/api` are served from the same local origin. During development, Vite proxies `/api` to the connector. No wildcard CORS is configured.
- **Host and Origin validation.** Every request is checked for a loopback Host header. Cross-origin requests must declare a loopback `http://` origin. Other hosts and origins receive HTTP 403, mitigating DNS rebinding and drive-by browser requests.
- **Per-run session token.** A random token is generated when the connector starts. State-changing API calls require it in the `x-dcat-token` header. The browser obtains it from `GET /api/session` through the same-origin proxy. `GET .../inventory?refresh=1` also requires the token because it forces slow CLI discovery; a plain cached GET stays token-free. Tokens are compared in constant time.
- **Fixed command allowlist.** The UI can request only typed operations: CLI status, org list/display, API version discovery, and allowlisted read-only REST paths. There is no generic command, shell, or URL proxy endpoint.
- **No shell.** Child processes are spawned with argument arrays and `shell: false`. On Windows, the Salesforce CLI `.cmd` shim is read only to locate its Node entry point, which is then spawned directly.
- **GET-only REST.** Salesforce REST calls use `GET` only and are restricted to `services/data/...` paths. Aliases are validated against the authenticated org list; object names and paths are validated and encoded.
- **Timeouts and size limits.** Process output is capped and commands are killed after a bounded timeout.
- **Redaction.** Raw CLI output is redacted before it is logged or returned. Access tokens, refresh tokens, auth URLs, bearer values, passwords, client secrets, and similar fields are never displayed or persisted. `sf org display --verbose` is never used.
- **No credential files.** The connector never reads or parses Salesforce CLI credential storage.
- **No record data.** Only configuration and schema metadata are retrieved; no SOQL queries against customer records are performed.
- **Local exports.** Metadata exports stay on the user's machine and must be initiated by the user. Exports can still reveal internal architecture, so treat them as sensitive and do not share them without approval.
- **No telemetry.** No analytics, external storage, or AI service receives org metadata.

## Hosted bridge edition (Cloudflare Worker + local agent)

- **No hosted OAuth and no credential collection.** `/api/auth/*` routes are removed (404). Salesforce login runs locally through `sf org login web` with a validated alias and optional HTTPS instance URL. No username, password, security token, SFDX auth URL, client id, client secret, encryption key, or login URL is sent to the site or stored by DCAT.
- **Outbound-only trust boundary.** The browser owns a session; a separate local agent polls the Worker's relay over HTTPS (`/api/relay/poll`) and returns redacted results via `/api/relay/respond`. No inbound connection to the user's machine is opened, and the browser never runs `sf`.
- **Session and CSRF.** A random session id is kept in an HttpOnly, Secure, SameSite cookie and records are stored in the existing `DCAT_SESSIONS` Workers KV namespace. `GET /api/session` returns a per-session CSRF token; mode changes, pairing, unpairing, relay requests, and refreshes require it in `x-dcat-token` and compare it in constant time. Sessions expire (default 30 days, configurable with `SESSION_TTL_SECONDS`).
- **One-time pairing.** A pairing code is bound to one browser session, expires after a short TTL, and is deleted when consumed. Only one agent can pair at a time; creating a new code replaces the old one, and unpairing deletes the agent-token mapping so stale polls are rejected.
- **Agent tokens and KV.** The agent authenticates relay calls with a random token that identifies exactly one session; KV holds only session/relay state (csrf token, mode, pairing metadata, the last request and its redacted result), never Salesforce credentials. KV writes are throttled to respect free-tier write limits. There is no shared global org connection.
- **Relay allowlist.** Only `cli.status`, `org.list`, `org.connect`, `inventory.get`, `transform.get`, and `mode.set` are accepted, validated by schemas. There is no arbitrary URL, command, shell, SOQL, or record-data proxy; transform ids are validated and only fixed read paths are used.
- **Redaction.** CLI output and error/result payloads are sanitized before being posted back or shown. Only configuration/schema metadata is requested; no customer records are queried.
- **Local agent storage.** The bridge writes only the relay URL, agent token, and version to local config with mode `600`. It does not parse Salesforce CLI credential files or store org credentials.
- **Same origin and demo isolation.** The Worker serves the SPA and `/api/*` from one origin (no wildcard CORS). Demo mode bypasses the relay entirely and uses labelled Worker fixtures; fixture data cannot be labelled Live, and switching modes clears the prior context.
- **No Worker secrets.** No `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`, `TOKEN_ENCRYPTION_KEY`, or `SF_LOGIN_URL` is configured or needed.

The local connector never runs in the Worker. Operational controls such as audit logging and a formal retention policy are not part of this scaffold; add them before using the hosted edition for regulated data. See [HOSTED_ONBOARDING.md](docs/HOSTED_ONBOARDING.md) for deployment and user flow.

## Browser metadata cache

Loaded org lists and inventory snapshots are stored in IndexedDB for the current browser origin and expire after 7 days. The persisted cache is an explicit allowlist: session/CSRF tokens, pairing codes and commands, health checks, transform details, and disabled-query placeholders are never written. The cache contains org metadata, so treat shared browsers accordingly; clearing site data removes it.

## Reporting a vulnerability

Please report security issues privately through the repository's security advisory feature rather than opening a public issue. Include reproduction steps and the affected version. Do not include real org credentials or customer data in a report.
