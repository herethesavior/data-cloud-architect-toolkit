import { CliError } from '@dcat/salesforce-cli';

export interface StoredBridge {
  relayUrl: string;
  token: string;
  version: string;
}

const PAIRING_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Only the deployed HTTPS origin or a local Wrangler origin may be a relay. */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'The relay URL is not valid.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username || url.password || (url.port && !local) ||
    url.pathname !== '/' || url.search || url.hash) {
    throw new CliError('INVALID_ARGUMENT', 'Use only the base HTTPS site URL shown by DCAT.');
  }
  return url.origin;
}

export function validatePairingCode(value: string): string {
  const code = value.trim();
  if (!PAIRING_PATTERN.test(code)) {
    throw new CliError('INVALID_ARGUMENT', 'The pairing code is not valid. Create a new one in the site.');
  }
  return code;
}

export function parseStoredBridge(value: unknown): StoredBridge {
  const stored = value as Partial<StoredBridge> | null;
  if (!stored || typeof stored !== 'object') {
    throw new CliError('INVALID_ARGUMENT', 'The saved bridge configuration is not valid. Run setup again.');
  }
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(String(stored.relayUrl ?? ''));
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'The saved bridge configuration is not valid. Run setup again.');
  }
  if (typeof stored.token !== 'string' || !PAIRING_PATTERN.test(stored.token)) {
    throw new CliError('INVALID_ARGUMENT', 'The saved bridge pairing is not valid. Run setup again.');
  }
  return {
    relayUrl,
    token: stored.token,
    version: typeof stored.version === 'string' ? stored.version.slice(0, 64) : '0.1.0',
  };
}
