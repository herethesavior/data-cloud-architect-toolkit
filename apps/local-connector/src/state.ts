import type { ApiVersionSelection, ApiVersionStatus, CliStatus, InventorySnapshot, OrgSummary } from '@dcat/core';
import { createApiVersionStatus } from '@dcat/core';
import { SalesforceCliAdapter } from '@dcat/salesforce-cli';
import type { ProcessRunner } from '@dcat/salesforce-cli';
import type { ProgressiveDiscoveryState, ResolvedApiVersion } from '@dcat/data360-api';
import { loadApiVersionSelection, saveApiVersionSelection } from './api-compatibility-store.ts';
import type { ConnectorConfig, ConnectorMode } from './config.ts';

/**
 * A live, in-memory discovery run. Cursors and partial rows stay inside the
 * connector process; the browser only sees an opaque session id and snapshots.
 */
export interface DiscoverySessionRecord {
  id: string;
  alias: string;
  generation: string;
  createdAt: number;
  updatedAt: number;
  state: ProgressiveDiscoveryState;
  latest: InventorySnapshot;
  controller: AbortController;
  running: boolean;
}

export interface AppState {
  config: ConnectorConfig;
  cli: SalesforceCliAdapter;
  mode: ConnectorMode;
  cliStatus: CliStatus;
  compatibility: ApiVersionStatus;
  orgsCache: { at: number; orgs: OrgSummary[] } | null;
  /** A progressive run may publish partial pages; those are not a full inventory. */
  inventoryCache: { at: number; alias: string; inventory: InventorySnapshot; partial?: boolean } | null;
  discoverySessions: Map<string, DiscoverySessionRecord>;
  discoveryByAlias: Map<string, string>;
}

export function createAppState(config: ConnectorConfig, runner?: ProcessRunner): AppState {
  return {
    config,
    cli: new SalesforceCliAdapter(runner),
    mode: config.mode,
    cliStatus: { installed: false, version: null, error: null },
    compatibility: createApiVersionStatus(loadApiVersionSelection(config.compatibilityPath)),
    orgsCache: null,
    inventoryCache: null,
    discoverySessions: new Map(),
    discoveryByAlias: new Map(),
  };
}

export async function refreshCliStatus(state: AppState): Promise<void> {
  state.cliStatus = await state.cli.status();
}

/** Discovery reports the resolved version back to health and relay status. */
export function recordApiVersionResolution(state: AppState): (result: ResolvedApiVersion) => void {
  return (result) => {
    state.compatibility = {
      ...createApiVersionStatus(result.selection),
      used: result.apiVersion,
      latest: result.probe.latest,
      verifiedAt: result.probe.failed ? null : new Date().toISOString(),
      probeStatus: result.probe.status,
    };
  };
}

export function setApiVersionSelection(state: AppState, selection: ApiVersionSelection): ApiVersionStatus {
  saveApiVersionSelection(state.config.compatibilityPath, selection);
  state.compatibility = createApiVersionStatus(selection);
  return state.compatibility;
}
