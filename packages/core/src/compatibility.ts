import { z } from 'zod';

/** DCAT's conservative, tested default. Salesforce supports each version for years. */
export const RECOMMENDED_API_VERSION = '67.0';

/** The constrained set of specific versions offered in Settings. */
export const CURATED_API_VERSIONS = ['65.0', '66.0', '67.0', '68.0'] as const;

export type CuratedApiVersion = (typeof CURATED_API_VERSIONS)[number];

export const apiVersionSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('recommended') }),
  z.object({ mode: z.literal('latest') }),
  z.object({ mode: z.literal('specific'), version: z.enum(CURATED_API_VERSIONS) }),
]);

export type ApiVersionSelection = z.infer<typeof apiVersionSelectionSchema>;
export type ApiVersionSelectionMode = ApiVersionSelection['mode'];

export const DEFAULT_API_VERSION_SELECTION: ApiVersionSelection = { mode: 'recommended' };

/**
 * Saved settings can come from an older bridge or an edited file. Fall back to
 * the safe default instead of letting a malformed value stop discovery.
 */
export function normalizeApiVersionSelection(value: unknown): ApiVersionSelection {
  return apiVersionSelectionSchema.safeParse(value).data ?? DEFAULT_API_VERSION_SELECTION;
}

export function isCuratedApiVersion(value: unknown): value is CuratedApiVersion {
  return typeof value === 'string' && (CURATED_API_VERSIONS as readonly string[]).includes(value);
}

export const apiVersionProbeStatusSchema = z.enum(['available', 'forbidden', 'unsupported', 'error']);

export const apiVersionStatusSchema = z.object({
  selection: apiVersionSelectionSchema,
  used: z.string().nullish(),
  latest: z.string().nullish(),
  recommended: z.string(),
  supported: z.array(z.string()),
  verifiedAt: z.string().nullish(),
  probeStatus: apiVersionProbeStatusSchema.nullish(),
});

export type ApiVersionStatus = z.infer<typeof apiVersionStatusSchema>;

/** A bridge that has not run discovery yet still has a known setting to show. */
export function createApiVersionStatus(selection: ApiVersionSelection = DEFAULT_API_VERSION_SELECTION): ApiVersionStatus {
  return {
    selection: normalizeApiVersionSelection(selection),
    used: null,
    latest: null,
    recommended: RECOMMENDED_API_VERSION,
    supported: [...CURATED_API_VERSIONS],
    verifiedAt: null,
    probeStatus: null,
  };
}
