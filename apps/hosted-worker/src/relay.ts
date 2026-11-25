import { Hono, type Context } from 'hono';
import {
  cliStatusSchema,
  RELAY_OPERATION_TIMEOUT_MS,
  relayAgentCancelRequestSchema,
  relayCancelRequestSchema,
  relayOperationSchema,
  relayPairRequestSchema,
  relayPollRequestSchema,
  relayRespondRequestSchema,
  type BridgeStatus,
  type CliStatus,
  type RelayPairing,
  type RelayRequestState,
} from '@dcat/core';
import { randomToken, tokenFingerprint } from './crypto.ts';
import { sendError, sendRouteError } from './errors.ts';
import type { RelayAgentSnapshot } from './relay-do.ts';
import { hasValidCsrf, loadSession, persistSession, resolveSession, saveSession, sessionTtl } from './session.ts';
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
/** A bridge that has just paired needs a moment to check in before we suggest re-pairing. */
const REPAIR_GRACE_MS = 2 * 60_000;

const RELAY_DO_ORIGIN = 'https://relay.invalid';

function emptyCli(): CliStatus {
  return { installed: false, version: null, error: null };
}

function resetSessionRelay(session: SessionRecord): void {
  session.relay = {
    agentToken: null,
    pairedAt: null,
    lastSeenAt: null,
    working: false,
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

interface StatusOverride {
  relay?: BridgeStatus['relay'];
  working?: boolean;
}

export function getBridgeStatus(session: SessionRecord, origin: string, override: StatusOverride = {}): BridgeStatus {
  const { agentToken, lastSeenAt, agentVersion, pairedAt } = session.relay;
  const now = Date.now();
  const stale = lastSeenAt !== null && now - lastSeenAt > STALE_AFTER_MS;
  // A bridge that paired but never checked in is only "waiting" during the
  // grace window. Past that, it needs the same repair affordance as a stale one.
  const neverCheckedIn = lastSeenAt === null && pairedAt !== null && now - pairedAt > REPAIR_GRACE_MS;
  const offline = stale || neverCheckedIn;
  const working = override.working === false ? false : Boolean(agentToken && session.relay.working);
  const relay = override.relay ?? (
    working ? 'working'
      : !agentToken || lastSeenAt === null && !neverCheckedIn ? 'waiting'
        : offline ? 'stale' : 'connected'
  );
  return {
    paired: Boolean(agentToken),
    mode: session.mode,
    version: RELAY_VERSION,
    cli: session.relay.cli ?? emptyCli(),
    lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    relay,
    working,
    canRepairPairing: Boolean(agentToken && pairedAt !== null && offline && now - pairedAt > REPAIR_GRACE_MS),
    pairing: pairingFor(session, origin),
    agentVersion: agentVersion ?? null,
    latestVersion: null,
    updateAvailable: false,
    selfUpdateSupported: false,
  };
}

/** Status for the setup card: compare the paired agent version with npm's latest. */
export async function getBridgeUpdateStatus(
  session: SessionRecord,
  origin: string,
  override: StatusOverride = {},
): Promise<BridgeStatus> {
  const status = getBridgeStatus(session, origin, override);
  if (!status.paired || !status.agentVersion) return status;
  const latestVersion = await latestBridgeVersion();
  return {
    ...status,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewerVersion(latestVersion, status.agentVersion),
    selfUpdateSupported: supportsSelfUpdate(status.agentVersion),
  };
}

type AgentStateBody = RelayAgentSnapshot & {
  paired?: boolean;
  error?: { code?: string; message?: string };
};

type PairingState = 'active' | 'unpaired' | 'unavailable';

function isInvalidAgentToken(body: AgentStateBody | null, status: number): boolean {
  return status === 401 && body?.error?.code === 'INVALID_AGENT_TOKEN';
}

/** Best-effort revocation: a dead DO must not prevent local session recovery. */
async function revokeAgentToken(env: Env, session: SessionRecord): Promise<void> {
  const token = session.relay.agentToken;
  if (!token) return;
  try {
    await relayFetch(env, token, '/unpair', { agentToken: token, sessionId: session.id });
  } catch {
    // The browser session is reset regardless; an obsolete bridge is harmless
    // once its token is no longer present in KV.
  }
}

async function agentState(env: Env, session: SessionRecord): Promise<{ status: number; body: AgentStateBody | null }> {
  const token = session.relay.agentToken;
  if (!token) return { status: 401, body: null };
  try {
    const { response, body } = await relayJson<AgentStateBody>(env, token, '/state', {
      agentToken: token,
      sessionId: session.id,
    });
    return { status: response.status, body };
  } catch {
    return { status: 502, body: null };
  }
}

export async function bridgeStatusForSession(
  env: Env,
  session: SessionRecord,
  origin: string,
  context?: Context,
): Promise<BridgeStatus> {
  const agentToken = session.relay.agentToken;
  if (!agentToken) return getBridgeUpdateStatus(session, origin);

  const { status, body } = await agentState(env, session);
  if (isInvalidAgentToken(body, status)) {
    await revokeAgentToken(env, session);
    resetSessionRelay(session);
    // Persist the reset so status and pairing routes agree immediately.
    if (context) await saveSession(context, env, session);
    else await persistSession(env, session);
    return getBridgeUpdateStatus(session, origin);
  }
  if (status !== 200 || !body?.paired) {
    // A network blip or 5xx is not evidence of an unpaired bridge. Keep the
    // last known pairing and show a retryable degraded state instead.
    return getBridgeUpdateStatus(session, origin, { relay: 'unavailable', working: false });
  }
  return getBridgeUpdateStatus({
    ...session,
    relay: {
      ...session.relay,
      lastSeenAt: body.lastSeenAt,
      agentVersion: body.agentVersion,
      cli: body.cli,
      working: body.working === true,
    },
  }, origin);
}

async function pairingState(env: Env, session: SessionRecord): Promise<PairingState> {
  if (!session.relay.agentToken) return 'unpaired';
  const { status, body } = await agentState(env, session);
  if (status === 200 && body?.paired) return 'active';
  return isInvalidAgentToken(body, status) ? 'unpaired' : 'unavailable';
}

async function recoverUnpairedSession(env: Env, session: SessionRecord): Promise<void> {
  await revokeAgentToken(env, session);
  resetSessionRelay(session);
}

/** Browser-owned cancellation used by both unpair and workspace mode changes. */
export async function clearRelayRequest(env: Env, session: SessionRecord): Promise<void> {
  const agentToken = session.relay.agentToken;
  if (!agentToken) return;
  try {
    await relayFetch(env, agentToken, '/cancel', { agentToken, sessionId: session.id });
  } catch {
    // Cancellation is best-effort; the request still expires at its deadline.
  }
}

export function relayRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/api/relay/status', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      return context.json(await bridgeStatusForSession(context.env, session, originOf(context.req.url), context));
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
        const state = await pairingState(context.env, session);
        if (state === 'active') {
          return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
        }
        if (state === 'unavailable') {
          return sendRouteError(context, {
            code: 'BRIDGE_STATUS_UNAVAILABLE',
            message: 'Bridge status is unavailable. Check the deployment and try again.',
          });
        }
        // An explicit 401 (or a pre-DO session) means the token is gone. Revoke
        // it best-effort before issuing a fresh code so no bridge is left behind.
        await recoverUnpairedSession(context.env, session);
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
      await saveSession(context, context.env, session);
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
        const state = await pairingState(context.env, session);
        if (state === 'active') {
          return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
        }
        if (state === 'unavailable') {
          return sendRouteError(context, {
            code: 'BRIDGE_STATUS_UNAVAILABLE',
            message: 'Bridge status is unavailable. Check the deployment and try again.',
          });
        }
        await recoverUnpairedSession(context.env, session);
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
        expiresAt: session.expiresAt ?? Date.now() + sessionTtl(context.env) * 1000,
        agentVersion,
        cli,
      });
      if (!initialized.ok) {
        // Never leave a usable-looking command behind when the relay cannot
        // initialize; the user must be able to retry without stale state.
        await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
        resetSessionRelay(session);
        await saveSession(context, context.env, session);
        return sendRouteError(context, {
          code: 'BRIDGE_RELAY_UNAVAILABLE',
          message: 'Bridge relay unavailable. Check the deployment, then create a new pairing code.',
        });
      }

      session.relay = {
        agentToken,
        pairedAt,
        lastSeenAt: null,
        working: false,
        agentVersion,
        cli,
        pairingCode: null,
        pairingExpiresAt: null,
        request: null,
      };
      await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
      await saveSession(context, context.env, session);
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
          expiresAt: now + RELAY_OPERATION_TIMEOUT_MS[parsed.data.operation],
        },
      );
      if (response.status === 401) {
        return sendError(
          context,
          409,
          'BRIDGE_PAIRING_RESET',
          'This bridge pairing was reset. Create a new pairing code in Connect org, then rerun setup.',
        );
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
      const { response, body } = await relayJson<RelayRequestState & {
        error?: { code?: string; message?: string };
      }>(
        context.env,
        agentToken,
        '/request',
        {
          agentToken,
          sessionId: session.id,
          id: context.req.param('id'),
          now: Date.now(),
          wait: context.req.query('wait') === '1',
        },
      );
      if (response.status === 401) {
        return sendError(
          context,
          409,
          'BRIDGE_PAIRING_RESET',
          'This bridge pairing was reset. Create a new pairing code in Connect org, then rerun setup.',
        );
      }
      if (!response.ok) {
        const code = body?.error?.code ?? 'NOT_FOUND';
        const message = body?.error?.message ?? 'The bridge request was not found.';
        return sendError(context, response.status as 400 | 404 | 409, code, message);
      }
      return context.json(body);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/cancel', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const parsed = relayCancelRequestSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'The request id is not valid.');
      }
      const agentToken = session.relay.agentToken;
      if (!agentToken) return context.json({ cancelled: false });
      const { response, body } = await relayJson<{ cancelled: boolean } & { error?: { code?: string } }>(
        context.env,
        agentToken,
        '/cancel',
        { agentToken, sessionId: session.id, requestId: parsed.data.requestId },
      );
      if (response.status === 401) {
        return sendError(context, 409, 'BRIDGE_PAIRING_RESET', 'This bridge pairing was reset.');
      }
      return context.json(body ?? { cancelled: false });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/relay/cancelled', async (context) => {
    try {
      const parsed = relayAgentCancelRequestSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!parsed.success) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The bridge pairing token is not valid.');
      }
      const response = await relayFetch(context.env, parsed.data.agentToken, '/cancelled', {
        agentToken: parsed.data.agentToken,
        requestId: parsed.data.requestId,
      });
      if (response.status === 401) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.');
      }
      return response;
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
      if (agentToken) await revokeAgentToken(context.env, session);
      resetSessionRelay(session);
      if (pairingCode) await context.env.DCAT_SESSIONS.delete(`pairing:${pairingCode}`);
      await saveSession(context, context.env, session);
      return context.json({ paired: false });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  return app;
}
