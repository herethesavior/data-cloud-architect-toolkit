import { ApiError } from './api.ts';

/**
 * Error copy shown to people, never raw exception text.
 *
 * Server and CLI failures routinely include type names, stack fragments, and
 * process output. None of that tells a user what to do next, so every visible
 * error is translated here into "what happened" plus "what to do about it".
 * Add a code mapping when a failure has a specific recovery path; otherwise the
 * context fallback keeps the message calm and actionable.
 */
export type UserErrorContext =
  | 'session'
  | 'orgs'
  | 'refresh'
  | 'connect'
  | 'inventory'
  | 'transform'
  | 'bridge'
  | 'diagnostics'
  | 'setup'
  | 'mode'
  | 'compatibility';

export type ErrorRecovery = 'connect' | 'retry' | 'continue';

export interface UserError {
  message: string;
  hint?: string;
  /** The next step the UI should offer for this failure, when it has one. */
  recovery?: ErrorRecovery;
}

const contextCopy: Record<UserErrorContext, UserError> = {
  session: {
    message: "DCAT couldn't start.",
    hint: 'Reload the page to try again.',
  },
  orgs: {
    message: "We couldn't check your Salesforce orgs.",
    hint: 'Try again. If it keeps happening, open Org Connections and check the bridge.',
    recovery: 'retry',
  },
  refresh: {
    message: "We couldn't refresh the org list.",
    hint: 'Try again. If it keeps happening, open Org Connections and check the bridge.',
  },
  connect: {
    message: "We couldn't connect that org.",
    hint: 'Check the Salesforce login window, then try again.',
  },
  inventory: {
    message: "We couldn't load this org's metadata.",
    hint: 'Try again. If it keeps happening, check the bridge in Org Connections or use demo mode.',
  },
  transform: {
    message: "We couldn't load this transform detail.",
    hint: 'Try again in a moment.',
  },
  bridge: {
    message: "We couldn't check the bridge status.",
    hint: 'Refresh status. If it keeps failing, open Org Connections and check the bridge.',
    recovery: 'retry',
  },
  diagnostics: {
    message: "We couldn't read diagnostics.",
    hint: 'Try again in a moment.',
  },
  setup: {
    message: "We couldn't complete bridge setup.",
    hint: 'Check the pairing code and try again.',
  },
  mode: {
    message: "We couldn't switch modes.",
    hint: 'Try again.',
  },
  compatibility: {
    message: "We couldn't save the API version.",
    hint: 'Try again. If it keeps happening, check the bridge in Org Connections.',
  },
};

const codeCopy: Record<string, UserError> = {
  ABORTED: { message: 'That request was cancelled.' },
  CANCELLED: { message: 'That request was cancelled.', hint: 'Try again if you still need it.' },
  TIMEOUT: {
    message: 'That request took longer than expected.',
    hint: 'Try again. If it keeps happening, check your connection.',
  },
  RELAY_TIMEOUT: {
    message: "The bridge didn't respond in time.",
    hint: 'Check that the bridge is running on your computer, then try again.',
  },
  RELAY_FAILED: {
    message: "The bridge couldn't complete that request.",
    hint: 'Try again. If it keeps happening, check the bridge in Org Connections.',
  },
  NETWORK_ERROR: {
    message: "We couldn't reach the service.",
    hint: 'Check your connection, then try again.',
  },
  BAD_RESPONSE: {
    message: 'The service returned an unexpected response.',
    hint: 'Try again in a moment.',
  },
  INVALID_SESSION_TOKEN: {
    message: 'Your session expired.',
    hint: 'Reload the page to start a new session.',
  },
  AUTH_REQUIRED: {
    message: 'Your session expired.',
    hint: 'Reload the page to start a new session.',
  },
  INVALID_AGENT_TOKEN: {
    message: 'The bridge pairing is no longer valid.',
    hint: 'Open Org Connections, create a new pairing code, and run the setup command again.',
    recovery: 'connect',
  },
  BRIDGE_PAIRING_RESET: {
    message: 'The bridge pairing was reset.',
    hint: 'Open Org Connections, create a new pairing code, and run the setup command again.',
    recovery: 'connect',
  },
  BRIDGE_NOT_CONNECTED: {
    message: 'The bridge is not connected.',
    hint: 'Open Org Connections and run the bridge setup command shown there.',
    recovery: 'connect',
  },
  BRIDGE_BUSY: {
    message: 'Another bridge request is still running.',
    hint: 'Wait for it to finish, then try again.',
    recovery: 'retry',
  },
  BRIDGE_STATUS_UNAVAILABLE: {
    message: "We couldn't reach the bridge service.",
    hint: 'Open Org Connections to check the bridge, then try again.',
    recovery: 'connect',
  },
  BRIDGE_RELAY_UNAVAILABLE: {
    message: "We couldn't reach the bridge service.",
    hint: 'Open Org Connections, create a new pairing code, and run setup again.',
    recovery: 'connect',
  },
  CLI_NOT_FOUND: {
    message: "Salesforce CLI wasn't found on this computer.",
    hint: 'Install Salesforce CLI, then open Org Connections to check again.',
    recovery: 'connect',
  },
  ORG_NOT_FOUND: {
    message: "That Salesforce org wasn't found.",
    hint: 'Refresh the org list and select it again.',
  },
  TRANSFORM_NOT_FOUND: {
    message: "That transform wasn't found.",
    hint: 'Refresh the inventory and open it again.',
  },
  RESPONSE_TOO_LARGE: {
    message: 'That metadata is too large to display in one view.',
    hint: 'Continue loading to receive this org in smaller batches.',
    recovery: 'continue',
  },
  INVALID_PAIRING_CODE: {
    message: "That pairing code isn't valid.",
    hint: 'Open Org Connections, create a fresh pairing code, and run setup again.',
    recovery: 'connect',
  },
  COMPATIBILITY_SAVE_FAILED: {
    message: "We couldn't save the API version on the bridge computer.",
    hint: 'Check that the bridge is running, then try again.',
    recovery: 'retry',
  },
};

/** Translate any thrown value into copy that is safe to render in the UI. */
export function describeError(error: unknown, context: UserErrorContext): UserError {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code ? codeCopy[code] : undefined) ?? contextCopy[context];
}

const technicalDetail = [
  /cannot read properties/i,
  /\b(?:type|syntax|reference)error\b/i,
  /unexpected token/i,
  /failed to fetch/i,
  /\b(?:networkerror|econn\w+)\b/i,
  /\bidfromstring\b/i,
  /\bundefined\b|\bnull is not\b/i,
  /salesforce cli command failed/i,
  /\b(?:error|status):\s*\d{3}\b/i,
  /\bfunctionality_not_enabled\b|\binvalid_field\b/i,
  /\bzoderror\b|\bat\s+\S+\s+\(/,
  /^\s*[{[]/,
];

/**
 * Diagnostic payloads carry both authored explanations and raw CLI/API output.
 * Keep the former, replace the latter with the caller's plain-language fallback.
 */
export function sanitizeDetail(message: string | null | undefined, fallback: string): string {
  if (!message) return fallback;
  const text = message.trim();
  if (!text || technicalDetail.some((pattern) => pattern.test(text))) return fallback;
  return text.slice(0, 300);
}
