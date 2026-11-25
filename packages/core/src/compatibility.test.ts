import { describe, expect, it } from 'vitest';
import {
  CURATED_API_VERSIONS,
  DEFAULT_API_VERSION_SELECTION,
  RECOMMENDED_API_VERSION,
  apiVersionSelectionSchema,
  createApiVersionStatus,
  normalizeApiVersionSelection,
} from './compatibility.ts';

describe('Salesforce API version compatibility', () => {
  it('defaults to the conservative DCAT-recommended pin', () => {
    expect(DEFAULT_API_VERSION_SELECTION).toEqual({ mode: 'recommended' });
    expect(RECOMMENDED_API_VERSION).toBe('67.0');
    expect(createApiVersionStatus()).toMatchObject({
      selection: { mode: 'recommended' },
      recommended: '67.0',
      supported: CURATED_API_VERSIONS,
      used: null,
      latest: null,
      probeStatus: null,
    });
  });

  it('accepts only curated versions for a specific override', () => {
    for (const version of CURATED_API_VERSIONS) {
      expect(apiVersionSelectionSchema.safeParse({ mode: 'specific', version }).success).toBe(true);
    }
    expect(apiVersionSelectionSchema.safeParse({ mode: 'specific', version: '99.0' }).success).toBe(false);
    expect(apiVersionSelectionSchema.safeParse({ mode: 'specific', version: '67' }).success).toBe(false);
  });

  it('falls back to the safe default for malformed saved settings', () => {
    expect(normalizeApiVersionSelection(null)).toEqual(DEFAULT_API_VERSION_SELECTION);
    expect(normalizeApiVersionSelection({ mode: 'specific', version: '1.0' })).toEqual(DEFAULT_API_VERSION_SELECTION);
    expect(normalizeApiVersionSelection({ mode: 'latest' })).toEqual({ mode: 'latest' });
  });
});
