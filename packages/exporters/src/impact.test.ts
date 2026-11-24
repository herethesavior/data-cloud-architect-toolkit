import { describe, expect, it } from 'vitest';
import { RESOURCE_FAMILIES } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import {
  analyzeImpact,
  buildImpactTargets,
  IMPACT_CONFIDENCE_LABELS,
  impactEvidenceText,
  impactSnapshotComplete,
  resolveImpactTarget,
} from './impact.ts';

function target(id: string) {
  const resolved = resolveImpactTarget(demoInventory, id);
  if (!resolved) throw new Error(`Missing test target: ${id}`);
  return resolved;
}

describe('change impact analysis', () => {
  it('indexes objects, fields, and relationships without inventing targets', () => {
    const targets = buildImpactTargets(demoInventory);
    expect(targets).toContainEqual(expect.objectContaining({
      id: 'dlo:Account_DLO__dll',
      kind: 'object',
      label: 'Account DLO',
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      id: 'field:dmo:Account_DMO__dlm:Industry',
      kind: 'field',
      fieldApiName: 'Industry',
      objectApiName: 'Account_DMO__dlm',
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      id: 'relationship:order-account',
      kind: 'relationship',
      relationshipId: 'order-account',
    }));
    expect(resolveImpactTarget(demoInventory, 'DLO:ACCOUNT_DLO__DLL')?.id).toBe('dlo:Account_DLO__dll');
    expect(resolveImpactTarget(demoInventory, 'field:nope')).toBeNull();
  });

  it('traces direct downstream object dependencies from a DLO', () => {
    const result = analyzeImpact(demoInventory, target('dlo:Account_DLO__dll'), {
      direction: 'downstream',
      depth: 'direct',
    });
    expect(result.downstreamCount).toBeGreaterThan(0);
    expect(result.upstreamCount).toBe(0);
    expect(result.items.some((item) =>
      item.group === 'mappings' && item.label.includes('Account_MAP__dlm'))).toBe(true);
    expect(result.items.some((item) =>
      item.group === 'objects' && item.id === 'dmo:Account_DMO__dlm')).toBe(true);
    expect(result.items.every((item) => item.hop === 1 || item.group === 'gaps')).toBe(true);
  });

  it('only claims an exact field dependency when the snapshot names that field', () => {
    const mapped = analyzeImpact(demoInventory, target('field:dlo:Account_DLO__dll:Industry'), {
      direction: 'downstream',
    });
    expect(mapped.exactFieldMatchCount).toBe(1);
    const fieldStep = mapped.items.flatMap((item) => item.steps)
      .find((step) => step.kind === 'field-mapping');
    expect(fieldStep?.label).toContain('Industry → Industry');
    expect(impactEvidenceText(mapped.items.find((item) => item.group === 'mappings')!))
      .toContain('Industry → Industry');

    const extended = structuredClone(demoInventory);
    const accountDlo = extended.dlos.find((entry) => entry.apiName === 'Account_DLO__dll');
    expect(accountDlo).toBeDefined();
    accountDlo!.fields.push({ ...accountDlo!.fields[0]!, apiName: 'UnmappedField', label: 'Unmapped Field' });
    const unmapped = analyzeImpact(
      extended,
      resolveImpactTarget(extended, 'field:dlo:Account_DLO__dll:UnmappedField')!,
      { direction: 'downstream' },
    );
    expect(unmapped.exactFieldMatchCount).toBe(0);
    expect(unmapped.items.some((item) =>
      item.steps.some((step) => step.objectLevelOnly && step.confidence === 'derived'))).toBe(true);
  });

  it('keeps relationship confidence and exposes join hints as review evidence', () => {
    const result = analyzeImpact(demoInventory, target('relationship:order-account'), {
      direction: 'both',
    });
    const relationship = result.items.filter((item) => item.group === 'relationships');
    expect(relationship.length).toBeGreaterThan(0);
    expect(relationship.some((item) => item.certainty === 'inferred' && item.confidence === 'derived')).toBe(true);
    expect(result.downstreamCount).toBeGreaterThan(0);
    expect(result.upstreamCount).toBeGreaterThan(0);
  });

  it('separates direct impact from the full reachable path', () => {
    const direct = analyzeImpact(demoInventory, target('dlo:Account_DLO__dll'), {
      direction: 'downstream',
      depth: 'direct',
    });
    const all = analyzeImpact(demoInventory, target('dlo:Account_DLO__dll'), {
      direction: 'downstream',
      depth: 'all',
    });
    expect(all.totalCount).toBeGreaterThan(direct.totalCount);
    expect(all.items.some((item) => item.hop > 1)).toBe(true);
  });

  it('surfaces unresolved references as gaps instead of silently dropping them', () => {
    const broken = structuredClone(demoInventory);
    const mapping = broken.mappings.find((entry) => entry.apiName === 'Account_MAP__dlm');
    expect(mapping).toBeDefined();
    mapping!.targetObject = 'Missing_DMO__dlm';

    const result = analyzeImpact(broken, resolveImpactTarget(broken, 'dlo:Account_DLO__dll')!, {
      direction: 'downstream',
    });
    expect(result.items.some((item) => item.group === 'gaps')).toBe(true);
    expect(result.items.some((item) => item.confidence === 'missing')).toBe(true);
    expect(IMPACT_CONFIDENCE_LABELS.missing).toBe('Missing reference');
  });

  it('reports snapshot completeness from the families impact depends on', () => {
    expect(impactSnapshotComplete(demoInventory)).toBe(true);
    const incomplete = structuredClone(demoInventory);
    const capability = incomplete.capabilities.find((entry) => entry.family === 'mappings');
    expect(capability).toBeDefined();
    capability!.status = 'unsupported';
    expect(impactSnapshotComplete(incomplete)).toBe(false);

    const inFlight = structuredClone(demoInventory);
    inFlight.progress = {
      sessionId: 'session-1',
      generation: 'generation-1',
      state: 'running',
      loaded: 10,
      total: null,
      families: RESOURCE_FAMILIES.map((family) => ({
        family,
        status: family === 'dlos' ? 'partial' : 'complete',
        loaded: family === 'dlos' ? 10 : 0,
        total: null,
        pagesFetched: 1,
        hasMore: family === 'dlos',
        error: null,
        errorStatus: null,
      })),
      message: 'Loading metadata in small batches.',
    };
    expect(impactSnapshotComplete(inFlight)).toBe(false);
  });
});
