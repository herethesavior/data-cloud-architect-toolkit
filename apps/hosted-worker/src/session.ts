import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { constantTimeEquals, randomToken } from './crypto.ts';
import type { ConnectorMode, Env, SessionRecord } from './types.ts';

const COOKIE_NAME = 'dcat_session';
const SESSION_PREFIX = 'session:';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function sessionTtl(env: Env): number {
  const configured = Number(env.SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SESSION_TTL_SECONDS;
}

function sessionKey(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

export async function loadSession(env: Env, id: string): Promise<SessionRecord | null> {
  const raw = await env.DCAT_SESSIONS.get(sessionKey(id), 'text');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionRecord;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.csrf !== 'string' || !parsed.relay) return null;
    if (typeof parsed.expiresAt === 'number' && Date.now() >= parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSessionCookie(context: Context, env: Env, id: string, maxAge = sessionTtl(env)): void {
  setCookie(context, COOKIE_NAME, id, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

/** Remaining life of the session, shared by KV, the cookie, and the Durable Object. */
function remainingTtl(env: Env, session: SessionRecord): number {
  const ttl = sessionTtl(env);
  session.expiresAt ??= Date.now() + ttl * 1000;
  return Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
}

export async function persistSession(env: Env, session: SessionRecord): Promise<number> {
  const ttl = remainingTtl(env, session);
  await env.DCAT_SESSIONS.put(sessionKey(session.id), JSON.stringify(session), {
    expirationTtl: ttl,
  });
  return ttl;
}

/**
 * Session state uses one absolute deadline. Sliding only KV or only the cookie
 * leaves a bridge paired to a session the browser can no longer present, and
 * sliding both would leave the Durable Object's revoked-token deadline behind.
 */
export async function saveSession(context: Context, env: Env, session: SessionRecord): Promise<void> {
  const ttl = await persistSession(env, session);
  setSessionCookie(context, env, session.id, ttl);
}

export function createSession(mode: ConnectorMode = 'live'): SessionRecord {
  return {
    id: randomToken(32),
    csrf: randomToken(32),
    mode,
    createdAt: Date.now(),
    relay: {
      agentToken: null,
      pairedAt: null,
      lastSeenAt: null,
      working: false,
      agentVersion: null,
      cli: { installed: false, version: null, error: null },
      pairingCode: null,
      pairingExpiresAt: null,
      request: null,
    },
  };
}

/** Reuse the browser's session when present; create and set one on the first visit. */
export async function resolveSession(context: Context, env: Env): Promise<SessionRecord> {
  const id = getCookie(context, COOKIE_NAME);
  if (id) {
    const existing = await loadSession(env, id);
    if (existing) return existing;
  }
  const session = createSession();
  await saveSession(context, env, session);
  return session;
}

/** The browser contract sends the session token in `x-dcat-token`. */
export function hasValidCsrf(context: Context, session: SessionRecord): boolean {
  const token = context.req.header('x-dcat-token');
  return Boolean(token) && constantTimeEquals(token!, session.csrf);
}
