import type { RetrievalStatus } from '@dcat/core';

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
