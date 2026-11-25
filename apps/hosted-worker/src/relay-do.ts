/// <reference types="@cloudflare/workers-types" />
import {
  cliStatusSchema,
  relayOperationSchema,
  relayResponseSchema,
  type CliStatus,
  type RelayOperation,
  type RelayRequestState,
  type RelayResponse,
  type RelayTask,
} from '@dcat/core';
import { constantTimeEquals, tokenFingerprint } from './crypto.ts';

/** Long-poll window. Short enough for fast pickup, long enough to avoid idle request churn. */
export const RELAY_LONG_POLL_MS = 20_000;
const SEEN_THROTTLE_MS = 20_000;
const STALE_AFTER_MS = 60_000;
/** One result is retained per session; this caps a hostile or accidental giant payload. */
export const MAX_RELAY_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface SqlResultLike {
  toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlResultLike;
}

interface StoredRequest {
  id: string;
  operation: RelayOperation;
  createdAt: number;
  expiresAt: number;
  claimedAt: number | null;
  response: RelayResponse | null;
  respondedAt: number | null;
}

export interface RelayAgentSnapshot {
  lastSeenAt: number | null;
  agentVersion: string | null;
  cli: CliStatus;
}

function emptyCli(): CliStatus {
  return { installed: false, version: null, error: null };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

async function readBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCli(value: unknown): CliStatus | null {
  const parsed = cliStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * All hot relay state lives in one SQLite-backed Durable Object per agent token.
 * This class is deliberately free of Durable Object globals so the logic can be
 * unit-tested with an injected SQL shim; `RelaySessionDO` below is the runtime shell.
 */
export class RelayDurableObjectCore {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly sql: SqlStorageLike) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS current_request (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      id TEXT NOT NULL,
      operation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      response TEXT,
      responded_at INTEGER
    )`);
  }

  private getMeta(key: string): string | null {
    const row = this.sql.exec('SELECT value FROM relay_meta WHERE key = ?', key).toArray()[0];
    return typeof row?.value === 'string' ? row.value : null;
  }

  private getMetaNumber(key: string): number | null {
    const value = this.getMeta(key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT INTO relay_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  private clearMeta(): void {
    this.sql.exec('DELETE FROM relay_meta');
  }

  private async authorized(body: Record<string, unknown>): Promise<string | null> {
    const token = body.agentToken;
    if (typeof token !== 'string' || token.length < 16) return null;
    if (this.getMeta('revoked') === '1') return null;
    const sessionId = this.getMeta('session_id');
    if (!sessionId) return null;
    const fingerprint = await tokenFingerprint(token);
    return constantTimeEquals(fingerprint, this.getMeta('token_fingerprint') ?? '') ? sessionId : null;
  }

  private readRequest(): StoredRequest | null {
    const row = this.sql.exec(`SELECT id, operation, created_at, expires_at, claimed_at, response, responded_at
      FROM current_request WHERE slot = 1`).toArray()[0];
    if (!row || typeof row.id !== 'string' || typeof row.operation !== 'string') return null;
    const operation = relayOperationSchema.safeParse(JSON.parse(row.operation));
    if (!operation.success) return null;
    const createdAt = Number(row.created_at);
    const expiresAt = Number(row.expires_at);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
    const response = typeof row.response === 'string'
      ? relayResponseSchema.safeParse(JSON.parse(row.response)).data ?? null
      : null;
    return {
      id: row.id,
      operation: operation.data,
      createdAt,
      expiresAt,
      claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
      response,
      respondedAt: row.responded_at === null || row.responded_at === undefined ? null : Number(row.responded_at),
    };
  }

  private saveRequest(request: StoredRequest): void {
    this.sql.exec('DELETE FROM current_request');
    this.sql.exec(`INSERT INTO current_request
      (slot, id, operation, created_at, expires_at, claimed_at, response, responded_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    request.id,
    JSON.stringify(request.operation),
    request.createdAt,
    request.expiresAt,
    request.claimedAt,
    request.response ? JSON.stringify(request.response) : null,
    request.respondedAt);
  }

  private requestState(request: StoredRequest, now: number): RelayRequestState {
    if (request.response) {
      return request.response.ok
        ? { id: request.id, status: 'completed', result: request.response.result, error: null }
        : { id: request.id, status: 'failed', result: null, error: request.response.error };
    }
    if (request.expiresAt <= now) {
      return {
        id: request.id,
        status: 'expired',
        result: null,
        error: { code: 'RELAY_TIMEOUT', message: 'The local bridge did not answer in time.' },
      };
    }
    return {
      id: request.id,
      status: request.claimedAt === null ? 'pending' : 'running',
      result: null,
      error: null,
    };
  }

  private wakeWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private agentSnapshot(): RelayAgentSnapshot {
    const rawCli = this.getMeta('cli');
    let cli: CliStatus | null = null;
    if (rawCli) {
      try {
        cli = parseCli(JSON.parse(rawCli));
      } catch {
        cli = null;
      }
    }
    return {
      lastSeenAt: this.getMetaNumber('last_seen_at'),
      agentVersion: this.getMeta('agent_version'),
      cli: cli ?? emptyCli(),
    };
  }

  private updateAgent(body: Record<string, unknown>, now: number): void {
    const cli = parseCli(body.cli);
    if (cli && JSON.stringify(cli) !== this.getMeta('cli')) {
      this.setMeta('cli', JSON.stringify(cli));
    }
    const version = typeof body.version === 'string' ? body.version.slice(0, 64) : null;
    if (version && version !== this.getMeta('agent_version')) {
      this.setMeta('agent_version', version);
    }
    const seen = this.getMetaNumber('last_seen_at');
    if (seen === null || now - seen >= SEEN_THROTTLE_MS) {
      this.setMeta('last_seen_at', String(now));
    }
  }

  private claimPending(now: number): RelayTask | null {
    const request = this.readRequest();
    if (!request || this.requestState(request, now).status !== 'pending') return null;
    this.sql.exec('UPDATE current_request SET claimed_at = ? WHERE slot = 1', now);
    return {
      id: request.id,
      operation: request.operation,
      createdAt: new Date(request.createdAt).toISOString(),
    };
  }

  async init(body: Record<string, unknown>): Promise<Response> {
    const token = body.agentToken;
    if (typeof token !== 'string' || token.length < 16 || typeof body.sessionId !== 'string') {
      return error('INVALID_ARGUMENT', 'Invalid pairing state.', 400);
    }
    const fingerprint = await tokenFingerprint(token);
    this.clearMeta();
    this.sql.exec('DELETE FROM current_request');
    this.setMeta('session_id', body.sessionId);
    this.setMeta('token_fingerprint', fingerprint);
    this.setMeta('paired_at', String(typeof body.pairedAt === 'number' ? body.pairedAt : Date.now()));
    this.setMeta('revoked', '0');
    const cli = parseCli(body.cli) ?? emptyCli();
    this.setMeta('cli', JSON.stringify(cli));
    if (typeof body.agentVersion === 'string') {
      this.setMeta('agent_version', body.agentVersion.slice(0, 64));
    }
    return json({ initialized: true });
  }

  async state(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId || sessionId !== body.sessionId || this.getMeta('revoked') === '1') {
      return error('INVALID_AGENT_TOKEN', 'The bridge pairing is no longer active.', 401);
    }
    return json({ paired: true, ...this.agentSnapshot() });
  }

  async poll(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId) {
      return error('INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.', 401);
    }
    const now = Date.now();
    this.updateAgent(body, now);
    const immediate = this.claimPending(now);
    if (immediate || body.wait !== true) {
      return json({ status: 'ok', tasks: immediate ? [immediate] : [] });
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, RELAY_LONG_POLL_MS);
      this.waiters.add(wake);
    });

    const task = this.claimPending(Date.now());
    return json({ status: 'ok', tasks: task ? [task] : [] });
  }

  async respond(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId) {
      return error('INVALID_AGENT_TOKEN', 'The site reset this bridge pairing. Run setup again.', 401);
    }
    const response = relayResponseSchema.safeParse(body.response);
    if (!response.success) {
      return error('INVALID_ARGUMENT', 'The bridge response is not valid.', 400);
    }
    const request = this.readRequest();
    if (!request || request.id !== response.data.id) {
      return error('NOT_FOUND', 'The bridge response does not match a pending request.', 404);
    }
    if (request.response) return json({ ok: true });
    const bytes = new TextEncoder().encode(JSON.stringify(response.data)).byteLength;
    if (bytes > MAX_RELAY_RESPONSE_BYTES) {
      return error('RESPONSE_TOO_LARGE', 'The bridge result is too large to relay.', 413);
    }
    this.sql.exec('UPDATE current_request SET response = ?, responded_at = ? WHERE slot = 1',
      JSON.stringify(response.data), Date.now());
    return json({ ok: true });
  }

  async queue(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId || body.sessionId !== sessionId) {
      return error('BRIDGE_NOT_CONNECTED', 'Set up the SF CLI bridge before connecting an org.', 401);
    }
    const operation = relayOperationSchema.safeParse(body.operation);
    const now = typeof body.now === 'number' ? body.now : Date.now();
    if (!operation.success || typeof body.requestId !== 'string'
      || typeof body.createdAt !== 'number' || typeof body.expiresAt !== 'number') {
      return error('INVALID_ARGUMENT', 'Unsupported bridge operation.', 400);
    }
    const seen = this.getMetaNumber('last_seen_at');
    if (seen !== null && now - seen > STALE_AFTER_MS) {
      return error('BRIDGE_NOT_CONNECTED', 'The local bridge is offline. Restart it and try again.', 409);
    }
    const active = this.readRequest();
    if (active) {
      const state = this.requestState(active, now);
      if (state.status === 'pending' || state.status === 'running') {
        if (JSON.stringify(active.operation) === JSON.stringify(operation.data)) {
          return json({ id: active.id, status: state.status });
        }
        return error('BRIDGE_BUSY', `A ${active.operation.operation} request is still running. Wait for it to finish.`, 409);
      }
    }
    this.saveRequest({
      id: body.requestId,
      operation: operation.data,
      createdAt: body.createdAt,
      expiresAt: body.expiresAt,
      claimedAt: null,
      response: null,
      respondedAt: null,
    });
    this.wakeWaiters();
    return json({ id: body.requestId, status: 'pending' });
  }

  async request(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId || body.sessionId !== sessionId) {
      return error('NOT_FOUND', 'The bridge request was not found.', 404);
    }
    const request = this.readRequest();
    if (!request || request.id !== body.id) {
      return error('NOT_FOUND', 'The bridge request was not found.', 404);
    }
    return json(this.requestState(request, typeof body.now === 'number' ? body.now : Date.now()));
  }

  async cancel(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId || body.sessionId !== sessionId) {
      return error('INVALID_AGENT_TOKEN', 'The bridge pairing is no longer active.', 401);
    }
    this.sql.exec('DELETE FROM current_request');
    return json({ cancelled: true });
  }

  async unpair(body: Record<string, unknown>): Promise<Response> {
    const sessionId = await this.authorized(body);
    if (!sessionId || body.sessionId !== sessionId) {
      return error('INVALID_AGENT_TOKEN', 'The bridge pairing is no longer active.', 401);
    }
    this.sql.exec('DELETE FROM current_request');
    this.setMeta('revoked', '1');
    this.clearMeta();
    return json({ paired: false });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return error('NOT_FOUND', 'Unknown relay operation.', 404);
    const body = await readBody<Record<string, unknown>>(request);
    if (!isRecord(body)) return error('INVALID_ARGUMENT', 'Invalid relay payload.', 400);

    switch (pathname) {
      case '/init': return this.init(body);
      case '/state': return this.state(body);
      case '/poll': return this.poll(body);
      case '/respond': return this.respond(body);
      case '/queue': return this.queue(body);
      case '/request': return this.request(body);
      case '/cancel': return this.cancel(body);
      case '/unpair': return this.unpair(body);
      default: return error('NOT_FOUND', 'Unknown relay operation.', 404);
    }
  }
}
