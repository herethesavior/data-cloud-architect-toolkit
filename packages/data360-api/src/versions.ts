import { z } from 'zod';
import type { RetrievalStatus } from '@dcat/core';
import {
  DEFAULT_API_VERSION_SELECTION,
  RECOMMENDED_API_VERSION,
  normalizeApiVersionSelection,
  type ApiVersionSelection,
} from '@dcat/core';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { classifyRestFailure, extractHttpStatus } from './capabilities.ts';

export const API_VERSION_PATTERN = /^\d{2,3}\.\d{1,2}$/;
export const VERSIONS_PATH = 'services/data/';

const versionEntrySchema = z.object({
  label: z.string().nullish(),
  version: z.union([z.string(), z.number()]).nullish(),
  url: z.string().nullish(),
});

/**
 * Parse the REST versions listing. Response shape is documented by Salesforce
 * but must still be validated against the target org; we never assume it.
 */
export function selectApiVersions(raw: string): string[] {
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
    .filter((value) => API_VERSION_PATTERN.test(value));

  if (versions.length === 0) {
    throw new CliError('UNEXPECTED_RESPONSE', 'No supported API version was returned by the org.');
  }

  return [...new Set(versions)].sort((a, b) => compareVersions(b, a));
}

export function selectLatestApiVersion(raw: string): string {
  return selectApiVersions(raw)[0]!;
}

export function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/** The concrete version a selection pins, or null when it follows the org. */
export function pinnedApiVersion(selection: ApiVersionSelection): string | null {
  if (selection.mode === 'recommended') return RECOMMENDED_API_VERSION;
  if (selection.mode === 'specific') return selection.version;
  return null;
}

export interface ApiVersionProbe {
  status: Extract<RetrievalStatus, 'available' | 'forbidden' | 'unsupported' | 'error'>;
  message: string;
  latest: string | null;
  available: string[];
  failed: boolean;
}

type ProbeFailureStatus = Extract<ApiVersionProbe['status'], 'forbidden' | 'unsupported' | 'error'>;

/** Probe copy never repeats CLI output: the raw text is only used to classify the failure. */
function describeProbeFailure(status: ProbeFailureStatus): string {
  switch (status) {
    case 'forbidden':
      return 'Access was denied while checking available API versions. Check Data 360 permissions, or use a pinned version.';
    case 'unsupported':
      return "This org doesn't expose the API version list. A pinned version can still be used.";
    default:
      return "DCAT couldn't check which API versions this org offers. A pinned version can still be used.";
  }
}

export interface ResolvedApiVersion {
  apiVersion: string | null;
  selection: ApiVersionSelection;
  probe: ApiVersionProbe;
}

/**
 * Resolve the API version once for both discovery paths.
 *
 * The versions listing is still read in pinned modes so diagnostics can show
 * what the org offers, but a transient listing failure no longer prevents a
 * known-good pinned version from loading metadata. `latest` keeps the old
 * fail-closed behavior because it has no concrete version to fall back to.
 */
export async function resolveApiVersion(
  restGet: () => Promise<string>,
  input?: ApiVersionSelection,
  onResolved?: (result: ResolvedApiVersion) => void,
): Promise<ResolvedApiVersion> {
  const selection = normalizeApiVersionSelection(input ?? DEFAULT_API_VERSION_SELECTION);
  let probe: ApiVersionProbe;

  try {
    const available = selectApiVersions(await restGet());
    probe = {
      status: 'available',
      message: `The org reports ${available[0]} as its latest API version.`,
      latest: available[0] ?? null,
      available,
      failed: false,
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    const classified = classifyRestFailure(extractHttpStatus(message), message);
    probe = {
      status: classified.status,
      message: describeProbeFailure(classified.status),
      latest: null,
      available: [],
      failed: true,
    };
  }

  const finish = (result: ResolvedApiVersion): ResolvedApiVersion => {
    try {
      onResolved?.(result);
    } catch {
      // Diagnostics must never turn a successful metadata load into a failure.
    }
    return result;
  };

  const pinned = pinnedApiVersion(selection);
  if (pinned) return finish({ apiVersion: pinned, selection, probe });
  if (probe.failed) return finish({ apiVersion: null, selection, probe });
  return finish({ apiVersion: probe.latest, selection, probe });
}

/** Capability copy for the shared `api-versions` diagnostic row. */
export function describeApiVersionResult(result: ResolvedApiVersion): { message: string; warning?: string } {
  if (!result.apiVersion) {
    return { message: result.probe.message };
  }

  const label =
    result.selection.mode === 'recommended'
      ? `DCAT-recommended API version ${result.apiVersion}`
      : result.selection.mode === 'specific'
        ? `selected API version ${result.apiVersion}`
        : `latest API version ${result.apiVersion}`;

  if (result.probe.failed) {
    return {
      message: `Using ${label}. The version list could not be checked, so the pinned version remains in use.`,
      warning: `DCAT couldn't check which API versions this org offers. It is using ${label} as requested.`,
    };
  }

  return { message: `Using ${label}. Latest available: ${result.probe.latest}.` };
}
