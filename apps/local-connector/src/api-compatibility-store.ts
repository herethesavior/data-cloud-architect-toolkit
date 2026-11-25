import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_API_VERSION_SELECTION, apiVersionSelectionSchema, type ApiVersionSelection } from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';

/**
 * API-version choice belongs to the machine running the bridge. The hosted
 * site only sees the resulting status in the bridge's session relay state.
 */
export function loadApiVersionSelection(path: string): ApiVersionSelection {
  try {
    const parsed = apiVersionSelectionSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return parsed.success ? parsed.data : DEFAULT_API_VERSION_SELECTION;
  } catch {
    return DEFAULT_API_VERSION_SELECTION;
  }
}

export function saveApiVersionSelection(path: string, selection: ApiVersionSelection): ApiVersionSelection {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions; the setting is not sensitive.
    }
  } catch {
    throw new CliError(
      'COMPATIBILITY_SAVE_FAILED',
      "We couldn't save the API version on this computer. Try again.",
    );
  }
  return selection;
}
