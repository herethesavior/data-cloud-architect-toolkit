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
  type RelayTask,
} from '@dcat/core';
import { constantTimeEquals, randomToken } from './crypto.ts';
import { sendError, sendRouteError } from './errors.ts';
import { hasValidCsrf, loadSession, resolveSession, saveSession, sessionTtl } from './session.ts';
import type { Env, RelayRequestRecord, SessionRecord } from './types.ts';

export const RELAY_VERSION = '0.1.0';

const PAIRING_TTL_SECONDS = 10 * 60;
const STALE_AFTER_MS = 2 * 60_000;
const SEEN_THROTTLE_MS = 60_000;
const RESULT_TTL_MS = 5 * 60_000;

const OPERATION_TIMEOUT_MS: Record<RelayOperation['operation'], number> = {
  'cli.status': 30_000,
  'org.list': 120_000,
  'org.connect': 6 * 60_000,
  'inventory.get': 120_000,
  'transform.get': 120_000,
  'mode.set': 30_000,
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
  const { agentToken, lastSeenAt } = session.relay;
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
  };
}

function requestState(record: RelayRequestRecord): RelayRequestState {
  return { id: record.id, status: record.status, result: record.result, error: record.error };
}

/** Expire a stranded request once, without writing KV on every poll. */
function expireRequest(session: SessionRecord): boolean {
  const record = session.relay.request;
  if (!record || (record.status !== 'pending' && record.status !== 'running')) return false;
  if (Date.now() < record.expiresAt) return false;
  record.status = 'expired';
  record.error = { code: 'RELAY_TIMEOUT', message: 'The local bridge did not answer in time.' };
  return true;
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
      return context.json(getBridgeStatus(session, originOf(context.req.url)));
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
      let changed = false;
      const cli = parseCli(parsed.data.cli);
      if (cli && JSON.stringify(cli) !== JSON.stringify(session.relay.cli)) {
        session.relay.cli = cli;
        changed = true;
      }
      if (session.relay.lastSeenAt === null || now - session.relay.lastSeenAt >= SEEN_THROTTLE_MS) {
        session.relay.lastSeenAt = now;
        changed = true;
      }
      if (expireRequest(session)) changed = true;

      const tasks: RelayTask[] = [];
      const record = session.relay.request;
      if (record?.status === 'pending') {
        record.status = 'running';
        changed = true;
        tasks.push({ id: record.id, operation: record.operation, createdAt: new Date(record.createdAt).toISOString() });
      }
      if (changed) await saveSession(context.env, session);
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
      const record = session.relay.request;
      if (!record || record.id !== response.id) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge response does not match a pending request.');
      }
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'expired') {
        return context.json({ ok: true });
      }
      if (response.ok) {
        record.status = 'completed';
        record.result = response.result;
        record.error = null;
      } else {
        record.status = 'failed';
        record.result = null;
        record.error = response.error;
      }
      record.expiresAt = Date.now() + RESULT_TTL_MS;
      await saveSession(context.env, session);
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
      const lastSeen = session.relay.lastSeenAt;
      if (lastSeen !== null && Date.now() - lastSeen > STALE_AFTER_MS) {
        return sendError(context, 409, 'BRIDGE_NOT_CONNECTED', 'The local bridge is offline. Restart it and try again.');
      }
      if (expireRequest(session)) await saveSession(context.env, session);
      const active = session.relay.request;
      if (active && (active.status === 'pending' || active.status === 'running')) {
        // A repeated click on the same operation must not queue a second org login.
        if (JSON.stringify(active.operation) === JSON.stringify(parsed.data)) {
          return context.json({ id: active.id, status: active.status });
        }
        return sendError(
          context,
          409,
          'BRIDGE_BUSY',
          `A ${active.operation.operation} request is still running. Wait for it to finish.`,
        );
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
      session.relay.request = record;
      await saveSession(context.env, session);
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
      const record = session.relay.request;
      if (!record || record.id !== context.req.param('id')) {
        return sendError(context, 404, 'NOT_FOUND', 'The bridge request was not found.');
      }
      if (expireRequest(session)) await saveSession(context.env, session);
      return context.json(requestState(record));
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
      session.relay = {
        agentToken: null,
        pairedAt: null,
        lastSeenAt: null,
        cli: emptyCli(),
        pairingCode: null,
        pairingExpiresAt: null,
        request: null,
      };
      if (oldToken) await context.env.DCAT_SESSIONS.delete(`agent:${oldToken}`);
      await saveSession(context.env, session);
      return context.json({ paired: false });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  return app;
}
