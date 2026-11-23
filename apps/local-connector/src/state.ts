import type { CliStatus, InventorySnapshot, OrgSummary } from '@dcat/core';
import { SalesforceCliAdapter } from '@dcat/salesforce-cli';
import type { ProcessRunner } from '@dcat/salesforce-cli';
import type { ProgressiveDiscoveryState } from '@dcat/data360-api';
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
  orgsCache: { at: number; orgs: OrgSummary[] } | null;
  inventoryCache: { at: number; alias: string; inventory: InventorySnapshot } | null;
  discoverySessions: Map<string, DiscoverySessionRecord>;
  discoveryByAlias: Map<string, string>;
}

export function createAppState(config: ConnectorConfig, runner?: ProcessRunner): AppState {
  return {
    config,
    cli: new SalesforceCliAdapter(runner),
    mode: config.mode,
    cliStatus: { installed: false, version: null, error: null },
    orgsCache: null,
    inventoryCache: null,
    discoverySessions: new Map(),
    discoveryByAlias: new Map(),
  };
}

export async function refreshCliStatus(state: AppState): Promise<void> {
  state.cliStatus = await state.cli.status();
}
