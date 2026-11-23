import { Hono } from 'hono';
import {
  cliStatusSchema,
  relayOperationSchema,
  relayPairRequestSchema,
  relayPollRequestSchema,
  relayRespondRequestSchema,
  relayResponseSchema,
  type BridgeStatus,
  type CliStatus,
  type RelayOperation,
  type RelayPairing,
  type RelayRequestState,
  type RelayTask,
} from '@dcat/core';
import { constantTimeEquals, randomToken } from './crypto.ts';
import { sendError, sendRouteError } from './errors.ts';
import { hasValidCsrf, loadSession, resolveSession, saveSession, sessionTtl } from './session.ts';
import type {
  Env,
  RelayAgentState,
  RelayClaimRecord,
  RelayRequestRecord,
  RelayResponseRecord,
  SessionRecord,
} from './types.ts';

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
const STALE_AFTER_MS = 2 * 60_000;
const SEEN_THROTTLE_MS = 60_000;
const RESULT_TTL_MS = 5 * 60_000;

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

function emptyCli(): CliStatus {
  return { installed: false, version: null, error: null };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(env: Env, key: string): Promise<unknown> {
  const raw = await env.DCAT_SESSIONS.get(key, 'text');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function relayTtl(env: Env, expiresAt: number): number {
  const seconds = Math.ceil((expiresAt - Date.now() + RESULT_TTL_MS) / 1000);
  return Math.max(60, Math.min(seconds, sessionTtl(env)));
}

function agentStateKey(sessionId: string): string {
  return `relay:agent:${sessionId}`;
}

function requestKey(sessionId: string): string {
  return `relay:request:${sessionId}`;
}

function claimKey(requestId: string): string {
  return `relay:claim:${requestId}`;
}

function responseKey(requestId: string): string {
  return `relay:response:${requestId}`;
}

function fallbackAgentState(session: SessionRecord): RelayAgentState {
  return {
    lastSeenAt: session.relay.lastSeenAt,
    agentVersion: session.relay.agentVersion,
    cli: session.relay.cli,
  };
}

/**
 * Each relay field has one writer: the browser owns pairing and requests,
 * while the agent owns heartbeats, claims and responses. Splitting them into
 * separate KV keys prevents a poll from overwriting a freshly queued request
 * or a browser mode change (KV has no conditional write).
 */
async function loadAgentState(env: Env, session: SessionRecord): Promise<RelayAgentState> {
  const fallback = fallbackAgentState(session);
  const stored = await readJson(env, agentStateKey(session.id));
  if (!isRecord(stored)) return fallback;
  return {
    lastSeenAt: 'lastSeenAt' in stored
      ? (typeof stored.lastSeenAt === 'number' ? stored.lastSeenAt : null)
      : fallback.lastSeenAt,
    agentVersion: 'agentVersion' in stored
      ? (typeof stored.agentVersion === 'string' ? stored.agentVersion : null)
      : fallback.agentVersion,
    cli: parseCli(stored.cli) ?? fallback.cli,
  };
}

async function saveAgentState(env: Env, sessionId: string, state: RelayAgentState): Promise<void> {
  await env.DCAT_SESSIONS.put(agentStateKey(sessionId), JSON.stringify(state), {
    expirationTtl: sessionTtl(env),
  });
}

function normalizeRequest(value: unknown): RelayRequestRecord | null {
  if (!isRecord(value)) return null;
  const operation = relayOperationSchema.safeParse(value.operation);
  if (!operation.success) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number') return null;
  const status = value.status === 'running' || value.status === 'completed'
    || value.status === 'failed' || value.status === 'expired'
    ? value.status
    : 'pending';
  const error = isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    ? { code: value.error.code, message: value.error.message }
    : null;
  return {
    id: value.id,
    operation: operation.data,
    status,
    result: value.result === undefined ? null : value.result,
    error,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

async function loadRequest(env: Env, session: SessionRecord): Promise<RelayRequestRecord | null> {
  // Sessions created before the split still carry their request inline.
  return normalizeRequest(await readJson(env, requestKey(session.id))) ?? normalizeRequest(session.relay.request);
}

async function saveRequest(env: Env, sessionId: string, record: RelayRequestRecord): Promise<void> {
  await env.DCAT_SESSIONS.put(requestKey(sessionId), JSON.stringify(record), {
    expirationTtl: relayTtl(env, record.expiresAt),
  });
}

async function loadClaim(env: Env, requestId: string): Promise<RelayClaimRecord | null> {
  const stored = await readJson(env, claimKey(requestId));
  if (!isRecord(stored) || typeof stored.sessionId !== 'string' || typeof stored.claimedAt !== 'number') {
    return null;
  }
  return { sessionId: stored.sessionId, claimedAt: stored.claimedAt };
}

async function loadResponse(env: Env, requestId: string): Promise<RelayResponseRecord | null> {
  const stored = await readJson(env, responseKey(requestId));
  if (!isRecord(stored) || typeof stored.respondedAt !== 'number') return null;
  const response = relayResponseSchema.safeParse(stored.response);
  return response.success ? { response: response.data, respondedAt: stored.respondedAt } : null;
}

async function resolveRequestState(
  env: Env,
  session: SessionRecord,
  record: RelayRequestRecord,
): Promise<RelayRequestState> {
  const [claim, response] = await Promise.all([
    loadClaim(env, record.id),
    loadResponse(env, record.id),
  ]);
  if (response) {
    return response.response.ok
      ? { id: record.id, status: 'completed', result: response.response.result, error: null }
      : { id: record.id, status: 'failed', result: null, error: response.response.error };
  }
  if (record.expiresAt <= Date.now()) {
    return {
      id: record.id,
      status: 'expired',
      result: null,
      error: { code: 'RELAY_TIMEOUT', message: 'The local bridge did not answer in time.' },
    };
  }
  return {
    id: record.id,
    status: claim?.sessionId === session.id ? 'running' : 'pending',
    result: null,
    error: null,
  };
}

async function bridgeStatusForSession(
  env: Env,
  session: SessionRecord,
  origin: string,
): Promise<BridgeStatus> {
  const agent = await loadAgentState(env, session);
  return getBridgeUpdateStatus({ ...session, relay: { ...session.relay, ...agent } }, origin);
}

async function sessionForAgent(env: Env, token: string): Promise<SessionRecord | null> {
  const sessionId = await env.DCAT_SESSIONS.get(`agent:${token}`, 'text');
  if (!sessionId) return null;
  const session = await loadSession(env, sessionId);
  if (!session?.relay.agentToken || !constantTimeEquals(token, session.relay.agentToken)) return null;
  return session;
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
        return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
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
        return sendError(context, 400, 'INVALID_PAIRING_CODE', 'The pairing code is invalid or has expired.');
      }
      if (session.relay.agentToken) {
        return sendError(context, 409, 'BRIDGE_ALREADY_PAIRED', 'This browser is already paired with a bridge.');
      }

      const oldToken = session.relay.agentToken;
      const agentToken = randomToken(32);
      session.relay = {
        agentToken,
        pairedAt: Date.now(),
        lastSeenAt: null,
        agentVersion: parsed.data.version ?? null,
        cli: parseCli(parsed.data.cli) ?? emptyCli(),
        pairingCode: null,
        pairingExpiresAt: null,
        request: null,
      };
      await context.env.DCAT_SESSIONS.put(`agent:${agentToken}`, session.id, {
        expirationTtl: sessionTtl(context.env),
      });
      if (oldToken) await context.env.DCAT_SESSIONS.delete(`agent:${oldToken}`);
      await context.env.DCAT_SESSIONS.delete(`pairing:${parsed.data.code}`);
      await saveSession(context.env, session);
      await saveAgentState(context.env, session.id, {
        lastSeenAt: null,
        agentVersion: session.relay.agentVersion,
        cli: session.relay.cli,
      });
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
      const session = await sessionForAgent(context.env, parsed.data.agentToken);
      if (!session) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.');
      }

      const now = Date.now();
      const agent = await loadAgentState(context.env, session);
      let changed = false;
      const cli = parseCli(parsed.data.cli);
      if (cli && JSON.stringify(cli) !== JSON.stringify(agent.cli)) {
        agent.cli = cli;
        changed = true;
      }
      const agentVersion = parsed.data.version?.slice(0, 64) ?? null;
      if (agentVersion && agentVersion !== agent.agentVersion) {
        agent.agentVersion = agentVersion;
        changed = true;
      }
      if (agent.lastSeenAt === null || now - agent.lastSeenAt >= SEEN_THROTTLE_MS) {
        agent.lastSeenAt = now;
        changed = true;
      }
      if (changed) await saveAgentState(context.env, session.id, agent);

      const tasks: RelayTask[] = [];
      const record = await loadRequest(context.env, session);
      if (record) {
        const state = await resolveRequestState(context.env, session, record);
        if (state.status === 'pending') {
          await context.env.DCAT_SESSIONS.put(claimKey(record.id), JSON.stringify({
            sessionId: session.id,
            claimedAt: now,
          } satisfies RelayClaimRecord), { expirationTtl: relayTtl(context.env, record.expiresAt) });
          tasks.push({
            id: record.id,
            operation: record.operation,
            createdAt: new Date(record.createdAt).toISOString(),
          });
        }
      }
      return context.json({ status: 'ok', tasks });
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
      const session = await sessionForAgent(context.env, parsed.data.agentToken);
      if (!session) {
        return sendError(context, 401, 'INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.');
      }
      const { response } = parsed.data;
      const record = await loadRequest(context.env, session);
      if (!record || record.id !== response.id) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge response does not match a pending request.');
      }
      if (await loadResponse(context.env, record.id)) return context.json({ ok: true });
      await context.env.DCAT_SESSIONS.put(responseKey(record.id), JSON.stringify({
        response,
        respondedAt: Date.now(),
      } satisfies RelayResponseRecord), { expirationTtl: relayTtl(context.env, record.expiresAt) });
      return context.json({ ok: true });
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
      if (!session.relay.agentToken) {
        return sendError(context, 409, 'BRIDGE_NOT_CONNECTED', 'Set up the SF CLI bridge before connecting an org.');
      }
      const agent = await loadAgentState(context.env, session);
      if (agent.lastSeenAt !== null && Date.now() - agent.lastSeenAt > STALE_AFTER_MS) {
        return sendError(context, 409, 'BRIDGE_NOT_CONNECTED', 'The local bridge is offline. Restart it and try again.');
      }
      const active = await loadRequest(context.env, session);
      if (active) {
        const state = await resolveRequestState(context.env, session, active);
        if (state.status === 'pending' || state.status === 'running') {
          // A repeated click on the same operation must not queue a second org login.
          if (JSON.stringify(active.operation) === JSON.stringify(parsed.data)) {
            return context.json({ id: active.id, status: state.status });
          }
          return sendError(
            context,
            409,
            'BRIDGE_BUSY',
            `A ${active.operation.operation} request is still running. Wait for it to finish.`,
          );
        }
      }

      const now = Date.now();
      const record: RelayRequestRecord = {
        id: randomToken(16),
        operation: parsed.data,
        status: 'pending',
        result: null,
        error: null,
        createdAt: now,
        expiresAt: now + OPERATION_TIMEOUT_MS[parsed.data.operation],
      };
      await saveRequest(context.env, session.id, record);
      return context.json({ id: record.id, status: record.status });
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
      const record = await loadRequest(context.env, session);
      if (!record || record.id !== context.req.param('id')) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge request was not found.');
      }
      return context.json(await resolveRequestState(context.env, session, record));
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
      const oldToken = session.relay.agentToken;
      const active = await loadRequest(context.env, session);
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
      if (oldToken) await context.env.DCAT_SESSIONS.delete(`agent:${oldToken}`);
      await context.env.DCAT_SESSIONS.delete(agentStateKey(session.id));
      await context.env.DCAT_SESSIONS.delete(requestKey(session.id));
      if (active) {
        await context.env.DCAT_SESSIONS.delete(claimKey(active.id));
        await context.env.DCAT_SESSIONS.delete(responseKey(active.id));
      }
      await saveSession(context.env, session);
      return context.json({ paired: false });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  return app;
}
