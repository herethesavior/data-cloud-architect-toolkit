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
  const unsupportedText = /unsupported|not enabled|unknown endpoint|(?:endpoint|resource|path|url)\s+not found/i;
  if (status === 404 || unsupportedText.test(message)) {
    return {
      status: 'unsupported',
      message: `This endpoint is unavailable for this org or API version. ${message}`.trim(),
    };
  }
  return { status: 'error', message: message || 'The request failed.' };
}
