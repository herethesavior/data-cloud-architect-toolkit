import { Hono } from 'hono';
import {
  cliStatusSchema,
  relayOperationSchema,
  relayPairRequestSchema,
  relayPollRequestSchema,
  relayRespondRequestSchema,
  type BridgeStatus,
  type CliStatus,
  type RelayOperation,
  type RelayPairing,
  type RelayRequestState,
} from '@dcat/core';
import { randomToken, tokenFingerprint } from './crypto.ts';
import { sendError, sendRouteError } from './errors.ts';
import type { RelayAgentSnapshot } from './relay-do.ts';
import { hasValidCsrf, loadSession, resolveSession, saveSession } from './session.ts';
import type { Env, SessionRecord } from './types.ts';

export const RELAY_VERSION = '0.1.0';

/** Older published bridges cannot decode `bridge.update`, so they get a manual upgrade command. */
const SELF_UPDATE_MIN_VERSION = '0.1.4';
const NPM_LATEST_URL = 'https://registry.npmjs.org/@dcat-toolkit/bridge/latest';
const NPM_VERSION_TTL_MS = 60 * 60 * 1000;
let cachedNpmVersion: { version: string; checkedAt: number } | null = null;
let npmVersionCheck: Promise<string | null> | null = null;

type NpmFetch = (input: RequestInfo | URL, init?: RequestInit & { cf?: { cacheTtl: number } }) => Promise<Response>;

async function fetchLatestBridgeVersion(fetchFn: NpmFetch): Promise<string | null> {
  try {
    const response = await fetchFn(NPM_LATEST_URL, { cf: { cacheTtl: 3600 } });
    if (!response.ok) return cachedNpmVersion?.version ?? null;
    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== 'string' || !/^\d+\.\d+\.\d+/.test(payload.version)) {
      return cachedNpmVersion?.version ?? null;
    }
    cachedNpmVersion = { version: payload.version, checkedAt: Date.now() };
    return cachedNpmVersion.version;
  } catch {
    return cachedNpmVersion?.version ?? null;
  }
}

/**
 * The Worker checks the npm registry itself so the browser never calls an
 * external URL. Concurrent status requests share one registry call.
 */
async function latestBridgeVersion(fetchFn: NpmFetch = fetch): Promise<string | null> {
  if (cachedNpmVersion && Date.now() - cachedNpmVersion.checkedAt < NPM_VERSION_TTL_MS) {
    return cachedNpmVersion.version;
  }
  npmVersionCheck ??= fetchLatestBridgeVersion(fetchFn).finally(() => {
    npmVersionCheck = null;
  });
  return npmVersionCheck;
}

/** Reset only for tests; production relies on the one-hour cache. */
export function resetNpmVersionCache(): void {
  cachedNpmVersion = null;
  npmVersionCheck = null;
}

function parseVersion(value: string | null | undefined): number[] | null {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: string | null | undefined, right: string | null | undefined): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1;
    if (leftParts[index]! < rightParts[index]!) return -1;
  }
  return 0;
}

function isNewerVersion(latest: string, current: string | null): boolean {
  return compareVersions(latest, current) > 0;
}

function supportsSelfUpdate(current: string | null): boolean {
  return compareVersions(current, SELF_UPDATE_MIN_VERSION) >= 0;
}

const PAIRING_TTL_SECONDS = 10 * 60;
const STALE_AFTER_MS = 60_000;

const OPERATION_TIMEOUT_MS: Record<RelayOperation['operation'], number> = {
  'cli.status': 30_000,
  'org.list': 120_000,
  'org.connect': 6 * 60_000,
  // Match the browser deadline so a client retry cannot arrive while the
  // original inventory request is still running on the bridge.
  'inventory.get': 60_000,
  'inventory.start': 60_000,
  'inventory.status': 30_000,
  'transform.get': 60_000,
  'mode.set': 30_000,
  'bridge.update': 5 * 60_000,
};

const RELAY_DO_ORIGIN = 'https://relay.invalid';

function emptyCli(): CliStatus {
  return { installed: false, version: null, error: null };
}

function resetSessionRelay(session: SessionRecord): void {
  session.relay = {
    agentToken: null,
    pairedAt: null,
    lastSeenAt: null,
    agentVersion: null,
    cli: emptyCli(),
    pairingCode: null,
    pairingExpiresAt: null,
    request: null,
  };
}

function parseCli(value: unknown): CliStatus | null {
  const parsed = cliStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Derive the DO id from the token itself: no KV read on any agent request. */
async function relayFetch(
  env: Env,
  agentToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const fingerprint = await tokenFingerprint(agentToken);
  const id = env.RELAY_DO.idFromString(fingerprint);
  const stub = env.RELAY_DO.get(id);
  return stub.fetch(new Request(`${RELAY_DO_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function relayJson<T>(
  env: Env,
  agentToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: T | null }> {
  const response = await relayFetch(env, agentToken, path, body);
  const payload = await response.json().catch(() => null) as T | null;
  return { response, body: payload };
}

function pairingFor(session: SessionRecord, origin: string): RelayPairing | null {
  const { pairingCode, pairingExpiresAt, agentToken } = session.relay;
  if (agentToken || !pairingCode || !pairingExpiresAt || pairingExpiresAt <= Date.now()) return null;
  return {
    code: pairingCode,
    expiresAt: new Date(pairingExpiresAt).toISOString(),
    installCommand: `npx -y @dcat-toolkit/bridge@latest setup --relay ${origin} --code ${pairingCode}`,
  };
}

export function getBridgeStatus(session: SessionRecord, origin: string): BridgeStatus {
  const { agentToken, lastSeenAt, agentVersion } = session.relay;
  const stale = lastSeenAt !== null && Date.now() - lastSeenAt > STALE_AFTER_MS;
  const relay = !agentToken || lastSeenAt === null ? 'waiting' : stale ? 'stale' : 'connected';
  return {
    paired: Boolean(agentToken),
    mode: session.mode,
    version: RELAY_VERSION,
    cli: session.relay.cli ?? emptyCli(),
    lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    relay,
    pairing: pairingFor(session, origin),
    agentVersion: agentVersion ?? null,
    latestVersion: null,
    updateAvailable: false,
    selfUpdateSupported: false,
  };
}

/** Status for the setup card: compare the paired agent version with npm's latest. */
export async function getBridgeUpdateStatus(session: SessionRecord, origin: string): Promise<BridgeStatus> {
  const status = getBridgeStatus(session, origin);
  if (!status.paired || !status.agentVersion) return status;
  const latestVersion = await latestBridgeVersion();
  return {
    ...status,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewerVersion(latestVersion, status.agentVersion),
    selfUpdateSupported: supportsSelfUpdate(status.agentVersion),
  };
}

export async function bridgeStatusForSession(
  env: Env,
  session: SessionRecord,
  origin: string,
): Promise<BridgeStatus> {
  const agentToken = session.relay.agentToken;
  if (!agentToken) return getBridgeUpdateStatus(session, origin);

  const { response, body } = await relayJson<RelayAgentSnapshot & { paired: boolean }>(
    env,
    agentToken,
    '/state',
    { agentToken, sessionId: session.id },
  );
  if (!response.ok || !body?.paired) {
    // The DO is authoritative about a pairing. If it no longer knows this
    // token, show an unpaired state instead of trusting stale session metadata.
    const staleSession = { ...session };
    resetSessionRelay(staleSession);
    return getBridgeUpdateStatus(staleSession, origin);
  }
  return getBridgeUpdateStatus({
    ...session,
    relay: { ...session.relay, lastSeenAt: body.lastSeenAt, agentVersion: body.agentVersion, cli: body.cli },
  }, origin);
}

/** Browser-owned cancellation used by both unpair and workspace mode changes. */
export async function clearRelayRequest(env: Env, session: SessionRecord): Promise<void> {
  const agentToken = session.relay.agentToken;
  if (!agentToken) return;
  await relayFetch(env, agentToken, '/cancel', { agentToken, sessionId: session.id });
}

export function relayRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/api/relay/status', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      return context.json(await bridgeStatusForSession(context.env, session, originOf(context.req.url)));
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/pairing', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      if (session.relay.agentToken) {
        const token = session.relay.agentToken;
        const active = await relayFetch(context.env, token, '/state', {
          agentToken: token,
          sessionId: session.id,
        }).then((response) => response.ok).catch(() => false);
        if (active) {
          return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
        }
        // A session paired before the Durable Object migration has no relay
        // state. Recover here so the user can create a fresh code immediately.
        resetSessionRelay(session);
      }
      const existing = pairingFor(session, originOf(context.req.url));
      if (existing) return context.json(existing);

      const code = randomToken(9);
      const previousCode = session.relay.pairingCode;
      session.relay.pairingCode = code;
      session.relay.pairingExpiresAt = Date.now() + PAIRING_TTL_SECONDS * 1000;
      await context.env.DCAT_SESSIONS.put(`pairing:${code}`, session.id, {
        expirationTtl: PAIRING_TTL_SECONDS,
      });
      if (previousCode) await context.env.DCAT_SESSIONS.delete(`pairing:${previousCode}`);
      await saveSession(context.env, session);
      return context.json(pairingFor(session, originOf(context.req.url)));
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/pair', async (context) => {
    try {
      const parsed = relayPairRequestSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 400, 'INVALID_PAIRING_CODE', 'The pairing code is not valid.');
      }
      const sessionId = await context.env.DCAT_SESSIONS.get(`pairing:${parsed.data.code}`, 'text');
      if (!sessionId) {
        return sendError(context, 400, 'INVALID_PAIRING_CODE', 'The pairing code is invalid or has expired.');
      }
      const session = await loadSession(context.env, sessionId);
      if (!session) {
        await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
        return sendError(context, 400, 'INVALID_PAIRING_CODE', 'The pairing code is invalid or has expired.');
      }
      if (session.relay.agentToken) {
        return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
      }
      const { pairingCode, pairingExpiresAt } = session.relay;
      if (!pairingCode || pairingCode !== parsed.data.code || !pairingExpiresAt || pairingExpiresAt <= Date.now()) {
        await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
        return sendError(context, 400, 'INVALID_PAIRING_CODE', 'The pairing code is invalid or has expired.');
      }

      const agentToken = randomToken(32);
      const pairedAt = Date.now();
      const agentVersion = parsed.data.version ?? null;
      const cli = parseCli(parsed.data.cli) ?? emptyCli();
      const initialized = await relayFetch(context.env, agentToken, '/init', {
        agentToken,
        sessionId: session.id,
        pairedAt,
        agentVersion,
        cli,
      });
      if (!initialized.ok) return sendRouteError(context, new Error('Could not initialize the bridge relay.'));

      session.relay = {
        agentToken,
        pairedAt,
        lastSeenAt: null,
        agentVersion,
        cli,
        pairingCode: null,
        pairingExpiresAt: null,
        request: null,
      };
      await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
      await saveSession(context.env, session);
      return context.json({ agentToken });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/poll', async (context) => {
    try {
      const parsed = relayPollRequestSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The bridge pairing token is not valid.');
      }
      const response = await relayFetch(context.env, parsed.data.agentToken, '/poll', {
        agentToken: parsed.data.agentToken,
        version: parsed.data.version,
        cli: parsed.data.cli,
        wait: parsed.data.wait === true,
      });
      if (response.status === 401) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.');
      }
      return response;
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/respond', async (context) => {
    try {
      const parsed = relayRespondRequestSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The bridge pairing token is not valid.');
      }
      const response = await relayFetch(context.env, parsed.data.agentToken, '/respond', {
        agentToken: parsed.data.agentToken,
        response: parsed.data.response,
      });
      if (response.status === 401) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.');
      }
      return response;
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/requests', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const parsed = relayOperationSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'Unsupported bridge operation.');
      }
      const agentToken = session.relay.agentToken;
      if (!agentToken) {
        return sendError(context, 409, 'BRIDGE_NOT_CONNECTED', 'Set up the SF CLI bridge before connecting an org.');
      }
      const now = Date.now();
      const requestId = randomToken(16);
      const { response, body } = await relayJson<{ id: string; status: string } & { error?: { code: string; message: string } }>(
        context.env,
        agentToken,
        '/queue',
        {
          agentToken,
          sessionId: session.id,
          requestId,
          operation: parsed.data,
          now,
          createdAt: now,
          expiresAt: now + OPERATION_TIMEOUT_MS[parsed.data.operation],
        },
      );
      if (response.status === 401) {
        return sendError(context, 409, 'BRIDGE_NOT_CONNECTED', 'Set up the SF CLI bridge before connecting an org.');
      }
      if (!response.ok) {
        const code = body?.error?.code ?? 'BRIDGE_NOT_CONNECTED';
        const message = body?.error?.message ?? 'The local bridge could not accept this request.';
        return sendError(context, response.status as 400 | 409, code, message);
      }
      return context.json(body);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/relay/requests/:id', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const agentToken = session.relay.agentToken;
      if (!agentToken) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge request was not found.');
      }
      const { response, body } = await relayJson<RelayRequestState>(
        context.env,
        agentToken,
        '/request',
        { agentToken, sessionId: session.id, id: context.req.param('id'), now: Date.now() },
      );
      if (!response.ok) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge request was not found.');
      }
      return context.json(body);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/unpair', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const agentToken = session.relay.agentToken;
      const pairingCode = session.relay.pairingCode;
      if (agentToken) {
        await relayFetch(context.env, agentToken, '/unpair', { agentToken, sessionId: session.id });
      }
      resetSessionRelay(session);
      if (pairingCode) await context.env.DCAT_SESSIONS.delete(`pairing:${pairingCode}`);
      await saveSession(context.env, session);
      return context.json({ paired: false });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  return app;
}
