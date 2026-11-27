import type { DataTransform, InventorySnapshot, OrgSummary } from '@dcat/core';
import { API_VERSION_PATTERN } from '@dcat/data360-api';
import { CliError } from '@dcat/salesforce-cli';
import { resolveInventory } from './routes/orgs.ts';
import type { AppState } from './state.ts';

export interface TransformContext {
  apiVersion: string | null;
  seed: DataTransform | null;
}

/** A caller-supplied version is a hint, never a path fragment until it is checked. */
export function validateApiVersionHint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !API_VERSION_PATTERN.test(value.trim())) {
    throw new CliError('INVALID_ARGUMENT', 'The API version hint contains unsupported characters.');
  }
  return value.trim();
}

function seedFor(inventory: InventorySnapshot | null, id: string): DataTransform | null {
  return inventory?.dataTransforms.find((transform) => transform.apiName === id || transform.id === id) ?? null;
}

/**
 * Transform detail only needs a version and an optional inventory fallback row.
 * Prefer the browser's already-resolved version and the connector's latest cache
 * so a detail request never waits for a full inventory discovery to finish.
 */
export async function resolveTransformContext(
  state: AppState,
  org: OrgSummary,
  id: string,
  apiVersionHint?: string,
): Promise<TransformContext> {
  const cached = state.inventoryCache?.alias === org.alias ? state.inventoryCache.inventory : null;
  const apiVersion = apiVersionHint ?? cached?.apiVersion ?? state.compatibility.used ?? null;
  const seed = seedFor(cached, id);
  if (apiVersion) return { apiVersion, seed };

  const inventory = await resolveInventory(state, org);
  return { apiVersion: inventory.apiVersion ?? null, seed: seedFor(inventory, id) ?? seed };
}
