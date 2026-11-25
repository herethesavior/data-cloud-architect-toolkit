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

const fallbackMessage = 'The request could not be completed.';

const technicalDetail = [
  /cannot read properties/i,
  /\b(?:type|syntax|reference)error\b/i,
  /unexpected token/i,
  /failed to fetch/i,
  /\bidfromstring\b/i,
  /\bundefined\b|\bnull is not\b/i,
  /salesforce cli command failed/i,
  /\b(?:error|status):\s*\d{3}\b/i,
  /\bfunctionality_not_enabled\b|\binvalid_field\b/i,
  /\bzoderror\b|\bat\s+\S+\s+\(/,
  /^\s*[{[]/,
];

function safeMessage(message: string | undefined): string {
  if (!message) return fallbackMessage;
  const text = message.trim();
  if (!text || technicalDetail.some((pattern) => pattern.test(text))) return fallbackMessage;
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/(agentToken)(?:\s*[:=]\s*|\s+)(["']?)[^"'\s,}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}

/**
 * Only messages authored by this app are safe to return. Anything else can be
 * a TypeError from a missing binding or raw CLI output, neither of which helps
 * a user recover. The web app translates the remaining codes into next steps.
 */
const trustedCodes = new Set([
  'BRIDGE_ALREADY_PAIRED',
  'BRIDGE_BUSY',
  'BRIDGE_NOT_CONNECTED',
  'BRIDGE_PAIRING_RESET',
  'BRIDGE_RELAY_UNAVAILABLE',
  'BRIDGE_STATUS_UNAVAILABLE',
  'CANCELLED',
  'CLI_NOT_FOUND',
  'INVALID_AGENT_TOKEN',
  'INVALID_ARGUMENT',
  'INVALID_PAIRING_CODE',
  'INVALID_SESSION_TOKEN',
  'NOT_FOUND',
  'ORG_NOT_FOUND',
  'RELAY_TIMEOUT',
  'RESPONSE_TOO_LARGE',
  'TRANSFORM_NOT_FOUND',
]);

const genericMessage = 'The service could not complete that request. Try again.';

function publicMessage(code: string | undefined, message: string | undefined): string {
  if (code && trustedCodes.has(code)) return safeMessage(message);
  return genericMessage;
}

function statusForCode(code: string | undefined): RouteStatus {
  if (code === 'INVALID_ARGUMENT' || code === 'INVALID_PAIRING_CODE') return 400;
  if (code === 'AUTH_REQUIRED' || code === 'INVALID_SESSION_TOKEN' || code === 'INVALID_AGENT_TOKEN') return 401;
  if (code === 'ORG_NOT_FOUND' || code === 'TRANSFORM_NOT_FOUND' || code === 'NOT_FOUND') return 404;
  if (code === 'BRIDGE_NOT_CONNECTED' || code === 'BRIDGE_BUSY' || code === 'BRIDGE_ALREADY_PAIRED'
    || code === 'BRIDGE_PAIRING_RESET') return 409;
  return 502;
}

export function sendRouteError(context: Context, error: unknown) {
  const { code, message } = errorDetails(error);
  const status = statusForCode(code);
  return context.json({ error: { code: code || 'REQUEST_FAILED', message: publicMessage(code, message) } }, status);
}

export function sendError(context: Context, status: Exclude<RouteStatus, 502>, code: string, message: string) {
  return context.json({ error: { code, message: publicMessage(code, message) } }, status);
}
