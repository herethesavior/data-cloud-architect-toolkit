const REDACTED = '[REDACTED]';

const sensitiveJsonValue = /("(?:accessToken|refreshToken|sfdxAuthUrl|authUrl|password|clientSecret|token|privateKey|jwt|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const authUrl = /\b(?:force|sf):\/\/[^\s"'<>]+/gi;
const bearerValue = /\b(?:Bearer|Authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{20,}/gi;
const salesforceTokenShape = /\b(?:00D|AQEA)[A-Za-z0-9!_.-]{20,}\b/g;

/** Remove credential-shaped values from any text before it is logged or returned. */
export function redactSensitive(text: string): string {
  return text
    .replace(sensitiveJsonValue, `$1"${REDACTED}"`)
    .replace(authUrl, REDACTED)
    .replace(bearerValue, REDACTED)
    .replace(salesforceTokenShape, REDACTED);
}

/** Build a user-facing error message that cannot leak process output. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitive(error.message).slice(0, 500);
  }
  return 'Unexpected Salesforce CLI error.';
}
