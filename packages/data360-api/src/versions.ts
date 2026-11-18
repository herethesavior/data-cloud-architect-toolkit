import { z } from 'zod';
import { CliError } from '@dcat/salesforce-cli';

const versionEntrySchema = z.object({
  label: z.string().nullish(),
  version: z.union([z.string(), z.number()]).nullish(),
  url: z.string().nullish(),
});

/**
 * Parse the REST versions listing. Response shape is documented by Salesforce
 * but must still be validated against the target org; we never assume it.
 */
export function selectLatestApiVersion(raw: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new CliError('UNEXPECTED_RESPONSE', 'The API versions response was not valid JSON.');
  }

  const parsed = z.array(versionEntrySchema).safeParse(decoded);
  if (!parsed.success) {
    throw new CliError('UNEXPECTED_RESPONSE', 'The API versions response format was not recognized.');
  }

  const versions = parsed.data
    .map((entry) => String(entry.version ?? entry.label ?? '').trim())
    .filter((value) => /^\d{2,3}\.\d{1,2}$/.test(value));

  if (versions.length === 0) {
    throw new CliError('UNEXPECTED_RESPONSE', 'No supported API version was returned by the org.');
  }

  return versions.sort((a, b) => compareVersions(b, a))[0]!;
}

export function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}
