const REDACTED = '[REDACTED]';

const sensitiveJsonValue = /("(?:accessToken|refreshToken|sfdxAuthUrl|authUrl|password|clientSecret|token|privateKey|jwt|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const authUrl = /\b(?:force|sf):\/\/[^\s"'<>]+/gi;
const bearerValue = /\b(?:Bearer|Authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{20,}/gi;
const salesforceTokenShape = /\b(?:00D|AQEA)[A-Za-z0-9!_.-]{20,}\b/g;

// The CLI prints these on every REST call. They are advisory, not failures, and
// must never be mistaken for the Salesforce API error on a non-zero exit.
const cliNotices = [
  /(?:^|[\r\n])[^\r\n]*\bWarning:\s*@salesforce\/cli update available from [^\r\n]*/gi,
  /\bWarning:\s*This command is currently in beta\.\s*Any aspect[\s\S]*?Don't use beta commands in your scripts\./gi,
  /\bWarning:\s*This command is currently in developer preview\.\s*Developer preview commands[\s\S]*?Don't use developer preview commands in your scripts\./gi,
];

/** Drop advisory CLI notices while preserving real error output. */
export function stripCliNotices(text: string): string {
  return cliNotices
    .reduce((value, pattern) => value.replace(pattern, ''), text)
    .replace(/[\r\n]{3,}/g, '\n\n')
    .trim();
}

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
