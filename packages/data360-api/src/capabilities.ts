import type { RetrievalStatus } from '@dcat/core';

/** Pull a numeric HTTP status out of a redacted CLI error message when present. */
export function extractHttpStatus(message: string): number | null {
  const patterns = [
    /\b(?:http\s+)?status(?:\s+code)?\s*[:=]?\s*([45]\d{2})\b/i,
    /\b(?:exit(?:ed)?(?:\s+with)?\s+code|error\s+code)\s*[:=]?\s*([45]\d{2})\b/i,
    /\((\d{3})\)/,
    /\b([45]\d{2})\s+(?:Forbidden|Unauthorized|Not Found|Bad Request|Server Error|error)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const status = Number(match[1]);
    if (status >= 400 && status <= 599) return status;
  }
  return null;
}

/** A 403 is access denied, not proof that Data 360 is disabled. */
export function classifyRestFailure(status: number | null, message: string): {
  status: Extract<RetrievalStatus, 'forbidden' | 'unsupported' | 'error'>;
  message: string;
} {
  if (status === 403) {
    return {
      status: 'forbidden',
      message: `Access denied. The current user may need Data 360 permissions or API access. ${message}`.trim(),
    };
  }
  const disabledText = /\bFUNCTIONALITY_NOT_ENABLED\b|\bnot\s+(?:currently\s+)?enabled\s+for\s+this\s+(?:user\s+type\s+or\s+org|org)\b/i;
  const unsupportedText = /unsupported|not\s+(?:currently\s+)?enabled|unknown endpoint|(?:endpoint|resource|path|url)\s+not found/i;
  if (status === 404 || unsupportedText.test(message)) {
    const reason = disabledText.test(message)
      ? 'Data 360 is not enabled for this user or org.'
      : 'This endpoint is unavailable for this org or API version.';
    return {
      status: 'unsupported',
      message: `${reason} ${message}`.trim(),
    };
  }
  return { status: 'error', message: message || 'The request failed.' };
}
