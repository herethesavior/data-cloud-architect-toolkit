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
  | 'mode';

export interface UserError {
  message: string;
  hint?: string;
}

const contextCopy: Record<UserErrorContext, UserError> = {
  session: {
    message: "DCAT couldn't start.",
    hint: 'Reload the page to try again.',
  },
  orgs: {
    message: "We couldn't check your Salesforce orgs.",
    hint: "Try again. If it keeps happening, check that you're on the production site and the bridge is running.",
  },
  refresh: {
    message: "We couldn't refresh the org list.",
    hint: 'Try again. If it keeps happening, check the bridge connection.',
  },
  connect: {
    message: "We couldn't connect that org.",
    hint: 'Check the Salesforce login window, then try again.',
  },
  inventory: {
    message: "We couldn't load this org's metadata.",
    hint: 'Try again. If it keeps happening, check the bridge connection or use demo mode.',
  },
  transform: {
    message: "We couldn't load this transform detail.",
    hint: 'Try again in a moment.',
  },
  bridge: {
    message: "We couldn't check the bridge status.",
    hint: "Refresh status. If it keeps failing, check that you're on the production site.",
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
    hint: 'Try again. If it keeps happening, check the bridge connection.',
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
    hint: 'Create a new pairing code in Connect an Org and run setup again.',
  },
  BRIDGE_PAIRING_RESET: {
    message: 'The bridge pairing was reset.',
    hint: 'Create a new pairing code in Connect an Org and run setup again.',
  },
  BRIDGE_NOT_CONNECTED: {
    message: 'The bridge is not connected.',
    hint: 'Start the bridge on your computer, then try again.',
  },
  BRIDGE_BUSY: {
    message: 'Another request is still running.',
    hint: 'Wait a moment, then try again.',
  },
  BRIDGE_STATUS_UNAVAILABLE: {
    message: "We couldn't reach the bridge service.",
    hint: "Check that you're on the production site, then refresh status.",
  },
  BRIDGE_RELAY_UNAVAILABLE: {
    message: "We couldn't reach the bridge service.",
    hint: "Check that you're on the production site, then try again.",
  },
  CLI_NOT_FOUND: {
    message: "Salesforce CLI wasn't found on this computer.",
    hint: 'Install Salesforce CLI, then re-check.',
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
    hint: 'Try a smaller org, or use demo mode to explore the sample data.',
  },
  INVALID_PAIRING_CODE: {
    message: "That pairing code isn't valid.",
    hint: 'Create a fresh pairing code in Connect an Org and run setup again.',
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
