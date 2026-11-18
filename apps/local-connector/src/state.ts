import type { CliStatus, InventorySnapshot, OrgSummary } from '@dcat/core';
import { SalesforceCliAdapter } from '@dcat/salesforce-cli';
import type { ProcessRunner } from '@dcat/salesforce-cli';
import type { ConnectorConfig, ConnectorMode } from './config.ts';

export interface AppState {
  config: ConnectorConfig;
  cli: SalesforceCliAdapter;
  mode: ConnectorMode;
  cliStatus: CliStatus;
  orgsCache: { at: number; orgs: OrgSummary[] } | null;
  inventoryCache: { at: number; alias: string; inventory: InventorySnapshot } | null;
}

export function createAppState(config: ConnectorConfig, runner?: ProcessRunner): AppState {
  return {
    config,
    cli: new SalesforceCliAdapter(runner),
    mode: config.mode,
    cliStatus: { installed: false, version: null, error: null },
    orgsCache: null,
    inventoryCache: null,
  };
}

export async function refreshCliStatus(state: AppState): Promise<void> {
  state.cliStatus = await state.cli.status();
}
