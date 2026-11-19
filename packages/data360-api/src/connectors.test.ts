import { describe, expect, it, vi } from 'vitest';
import { CliError } from '@dcat/salesforce-cli';
import type { DataStream } from '@dcat/core';
import {
  connectorCatalogJson,
  connectorConnectionsJson,
  demoInventory,
} from '@dcat/test-fixtures';
import { enrichStreamConnectors } from './connectors.ts';
import type { RestClient } from './discover.ts';
import { buildConnectorCatalogPath, buildConnectorConnectionsPath } from './endpoints.ts';

const baseStream: DataStream = {
  ...demoInventory.dataStreams[0]!,
  sourceConnector: 'SalesforceDotCom',
  sourceConnectorLabel: null,
  sourceConnectionName: 'SalesforceDotCom_Home',
  sourceConnectionLabel: null,
  sourceConnectionStatus: null,
  sourceDataSource: 'Salesforce_Home',
  connectorLookup: null,
};

const catalogPath = buildConnectorCatalogPath('68.0');
const connectionsPath = buildConnectorConnectionsPath('68.0', 'SalesforceDotCom');

function successfulCli(): RestClient {
  return {
    restGet: vi.fn(async (_alias: string, path: string) => {
      if (path === catalogPath) return connectorCatalogJson;
      if (path === connectionsPath) return connectorConnectionsJson;
      throw new Error(`Unexpected REST path: ${path}`);
    }),
  };
}

describe('connector enrichment', () => {
  it('resolves friendly labels and configured connection details without changing the raw code', async () => {
    const cli = successfulCli();
    const result = await enrichStreamConnectors({
      cli,
      alias: 'my-data360-org',
      apiVersion: '68.0',
      streams: [baseStream],
      retrievedAt: '2026-11-19T00:00:00.000Z',
    });

    expect(result.streams[0]).toMatchObject({
      apiName: baseStream.apiName,
      sourceConnector: 'SalesforceDotCom',
      sourceConnectorLabel: 'Salesforce CRM',
      sourceConnectionName: 'SalesforceDotCom_Home',
      sourceConnectionLabel: 'EPIC OrgFarm',
      sourceConnectionStatus: 'Connected',
      sourceDataSource: 'Salesforce_Home',
      connectorLookup: {
        endpoints: [catalogPath, connectionsPath],
        apiVersion: '68.0',
        retrievedAt: '2026-11-19T00:00:00.000Z',
      },
    });
    expect(result.warnings).toHaveLength(0);
    expect(cli.restGet).toHaveBeenCalledWith('my-data360-org', catalogPath);
    expect(cli.restGet).toHaveBeenCalledWith('my-data360-org', connectionsPath);
  });

  it('matches a configured connection by data source when the stream omits the connection name', async () => {
    const cli = successfulCli();
    const result = await enrichStreamConnectors({
      cli,
      alias: 'my-data360-org',
      apiVersion: '68.0',
      streams: [{ ...baseStream, sourceConnectionName: null }],
    });

    expect(result.streams[0]?.sourceConnectionLabel).toBe('EPIC OrgFarm');
  });

  it('swallows lookup failures and keeps the normalized stream intact', async () => {
    const cli: RestClient = {
      restGet: vi.fn(async () => {
        throw new CliError('COMMAND_FAILED', 'Status: 500 Server Error');
      }),
    };
    const result = await enrichStreamConnectors({
      cli,
      alias: 'my-data360-org',
      apiVersion: '68.0',
      streams: [baseStream],
    });

    expect(result.streams[0]).toMatchObject({
      sourceConnector: 'SalesforceDotCom',
      sourceConnectorLabel: null,
      sourceConnectionLabel: null,
      connectorLookup: null,
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'CONNECTOR_CATALOG_LOOKUP_FAILED',
      'CONNECTOR_CONNECTION_LOOKUP_FAILED',
    ]);
    expect(result.warnings.every((warning) => warning.severity === 'info')).toBe(true);
  });

  it('does not issue lookup calls when there are no streams to enrich', async () => {
    const cli = successfulCli();
    const result = await enrichStreamConnectors({
      cli,
      alias: 'my-data360-org',
      apiVersion: '68.0',
      streams: [],
    });

    expect(result.streams).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(cli.restGet).not.toHaveBeenCalled();
  });
});
