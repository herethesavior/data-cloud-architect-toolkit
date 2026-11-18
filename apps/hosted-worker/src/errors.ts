import type { Context } from 'hono';

export type RouteStatus = 400 | 401 | 404 | 409 | 502;

export interface RouteErrorShape {
  code?: string;
  message?: string;
}

function errorDetails(error: unknown): RouteErrorShape {
  if (error && typeof error === 'object') {
    const shaped = error as RouteErrorShape;
    return { code: shaped.code, message: shaped.message };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function safeMessage(message: string | undefined): string {
  const redacted = (message || 'The request could not be completed.')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/(agentToken)(?:\s*[:=]\s*|\s+)(["']?)[^"'\s,}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
  return redacted;
}

function statusForCode(code: string | undefined): RouteStatus {
  if (code === 'INVALID_ARGUMENT' || code === 'INVALID_PAIRING_CODE') return 400;
  if (code === 'AUTH_REQUIRED' || code === 'INVALID_SESSION_TOKEN' || code === 'INVALID_AGENT_TOKEN') return 401;
  if (code === 'ORG_NOT_FOUND' || code === 'TRANSFORM_NOT_FOUND' || code === 'NOT_FOUND') return 404;
  if (code === 'BRIDGE_NOT_CONNECTED' || code === 'BRIDGE_BUSY' || code === 'BRIDGE_ALREADY_PAIRED') return 409;
  return 502;
}

export function sendRouteError(context: Context, error: unknown) {
  const { code, message } = errorDetails(error);
  const status = statusForCode(code);
  return context.json({ error: { code: code || 'REQUEST_FAILED', message: safeMessage(message) } }, status);
}

export function sendError(context: Context, status: Exclude<RouteStatus, 502>, code: string, message: string) {
  return context.json({ error: { code, message: safeMessage(message) } }, status);
}
