import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConnectorConfig } from './config.ts';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(value: string): boolean {
  const hostname = hostnameOf(value);
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * The connector is a local-only service. Reject non-loopback Host and Origin
 * values so a remote page or DNS-rebinding attempt cannot reach the API.
 */
export function registerSecurity(app: FastifyInstance, _config: ConnectorConfig): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = request.headers.host ?? '';
    if (!isLoopback(host)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN_HOST', message: 'Local connector access only.' } });
    }

    const origin = request.headers.origin;
    if (origin && (!origin.startsWith('http://') || !isLoopback(origin.slice('http://'.length).split('/')[0] ?? ''))) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Unexpected request origin.' } });
    }

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
}

/** Compare tokens without leaking their contents through timing differences. */
export function hasSessionToken(config: ConnectorConfig, value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  const provided = Buffer.from(value);
  const expected = Buffer.from(config.sessionToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Per-run token required for state-changing local API calls. */
export function requireSessionToken(config: ConnectorConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasSessionToken(config, request.headers['x-dcat-token'])) {
      return reply.code(401).send({
        error: { code: 'INVALID_SESSION_TOKEN', message: 'Refresh the page and try again.' },
      });
    }
  };
}
