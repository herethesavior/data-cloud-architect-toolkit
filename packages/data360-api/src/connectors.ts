import type { DataStream, RetrievalWarning } from '@dcat/core';
import { safeErrorMessage } from '@dcat/salesforce-cli';
import type { RestClient } from './discover.ts';
import {
  buildConnectorCatalogPath,
  buildConnectorConnectionsPath,
  isValidConnectorType,
} from './endpoints.ts';
import { extractCollection, firstStringValue, isRecord, parseJsonResponse } from './normalize.ts';

/** Informational warnings use a synthetic family so family progress counts stay honest. */
export const STREAM_ENRICHMENT_WARNING_FAMILY = 'stream-enrichment';
export const MAX_CONNECTION_LOOKUP_TYPES = 12;

export interface ConnectorEnrichmentOptions {
  cli: RestClient;
  alias: string;
  apiVersion: string;
  streams: DataStream[];
  retrievedAt?: string;
}

export interface ConnectorEnrichmentResult {
  streams: DataStream[];
  warnings: RetrievalWarning[];
}

interface ConnectorConnection {
  type: string;
  name: string | null;
  label: string | null;
  status: string | null;
  dataSource: string | null;
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function catalogLabels(raw: string): Map<string, string> {
  const labels = new Map<string, string>();
  const entries = extractCollection(parseJsonResponse(raw, 'Connector catalog'), 'Connector catalog');
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = firstStringValue(entry, ['name', 'connectorType', 'apiName']);
    const label = firstStringValue(entry, ['label', 'displayName', 'Name']);
    if (name && label) labels.set(name, label);
  }
  return labels;
}

function connections(raw: string, connectorType: string): ConnectorConnection[] {
  const result: ConnectorConnection[] = [];
  const entries = extractCollection(parseJsonResponse(raw, `${connectorType} connections`), `${connectorType} connections`);
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    result.push({
      type: connectorType,
      name: firstStringValue(entry, ['name', 'developerName']),
      label: firstStringValue(entry, ['label', 'displayName']),
      status: firstStringValue(entry, ['connectionStatus', 'status']),
      dataSource: firstStringValue(entry, ['dataSource']),
    });
  }
  return result;
}

function bestConnection(
  stream: DataStream,
  candidates: ConnectorConnection[],
): ConnectorConnection | null {
  return candidates.find((candidate) => sameText(candidate.name, stream.sourceConnectionName))
    ?? candidates.find((candidate) => sameText(candidate.dataSource, stream.sourceDataSource))
    ?? (candidates.length === 1 ? candidates[0]! : null);
}

function enrichmentWarning(code: string, path: string, error: unknown): RetrievalWarning {
  return {
    family: STREAM_ENRICHMENT_WARNING_FAMILY,
    code,
    message: `Connector lookup failed for ${path}: ${safeErrorMessage(error)}`,
    severity: 'info',
  };
}

/**
 * Resolve friendly connector and configured-connection names for streams already
 * normalized from inventory. Every lookup is best-effort: a failed catalog or
 * connection endpoint leaves the raw stream fields intact and never fails discovery.
 */
export async function enrichStreamConnectors(
  options: ConnectorEnrichmentOptions,
): Promise<ConnectorEnrichmentResult> {
  const { cli, alias, apiVersion, streams } = options;
  if (streams.length === 0) return { streams, warnings: [] };

  const catalogPath = buildConnectorCatalogPath(apiVersion);
  const types = [...new Set(streams
    .map((stream) => stream.sourceConnector?.trim())
    .filter((value): value is string => Boolean(value && isValidConnectorType(value))))]
    .sort();
  const limitedTypes = types.slice(0, MAX_CONNECTION_LOOKUP_TYPES);
  const connectionPaths = new Map(limitedTypes.map((type) => [
    type,
    buildConnectorConnectionsPath(apiVersion, type),
  ]));
  const paths = [catalogPath, ...connectionPaths.values()];

  const warnings: RetrievalWarning[] = [];
  if (types.length > limitedTypes.length) {
    warnings.push({
      family: STREAM_ENRICHMENT_WARNING_FAMILY,
      code: 'CONNECTOR_LOOKUP_LIMITED',
      message: `Resolved connection labels for ${limitedTypes.length} of ${types.length} connector types.`,
      severity: 'info',
    });
  }

  const settled = await Promise.allSettled(paths.map((path) => cli.restGet(alias, path)));
  const labels = new Map<string, string>();
  const byType = new Map<string, ConnectorConnection[]>();
  const succeededPaths: string[] = [];

  settled.forEach((outcome, index) => {
    const path = paths[index]!;
    if (outcome.status === 'rejected') {
      warnings.push(enrichmentWarning(
        path === catalogPath ? 'CONNECTOR_CATALOG_LOOKUP_FAILED' : 'CONNECTOR_CONNECTION_LOOKUP_FAILED',
        path,
        outcome.reason,
      ));
      return;
    }
    try {
      if (path === catalogPath) {
        for (const [name, label] of catalogLabels(outcome.value)) labels.set(name, label);
      } else {
        for (const [type, connectionPath] of connectionPaths) {
          if (path === connectionPath) byType.set(type, connections(outcome.value, type));
        }
      }
      succeededPaths.push(path);
    } catch (error) {
      warnings.push(enrichmentWarning(
        path === catalogPath ? 'CONNECTOR_CATALOG_LOOKUP_FAILED' : 'CONNECTOR_CONNECTION_LOOKUP_FAILED',
        path,
        error,
      ));
    }
  });

  const connectorLookup = succeededPaths.length > 0
    ? {
        endpoints: succeededPaths,
        apiVersion,
        retrievedAt: options.retrievedAt ?? new Date().toISOString(),
      }
    : null;

  const enriched = streams.map((stream): DataStream => {
    const rawType = stream.sourceConnector?.trim() ?? '';
    const label = labels.get(rawType) ?? stream.sourceConnectorLabel;
    const connection = bestConnection(stream, byType.get(rawType) ?? []);
    const connectionName = connection?.name ?? stream.sourceConnectionName;
    const connectionLabel = connection?.label ?? stream.sourceConnectionLabel;
    const connectionStatus = connection?.status ?? stream.sourceConnectionStatus;
    const dataSource = connection?.dataSource ?? stream.sourceDataSource;

    return {
      ...stream,
      sourceConnectorLabel: label,
      sourceConnectionName: connectionName,
      sourceConnectionLabel: connectionLabel,
      sourceConnectionStatus: connectionStatus,
      sourceDataSource: dataSource,
      connectorLookup: connectorLookup ?? stream.connectorLookup,
    };
  });

  return { streams: enriched, warnings };
}
