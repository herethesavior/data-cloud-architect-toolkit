import { useEffect, useRef, useState } from 'react';
import type { DataStream, InventorySnapshot } from '@dcat/core';
import { downloadTextFile, exportCsvTable, exportInventoryJson, exportInventoryMarkdown } from '@dcat/exporters';
import { EmptyState } from '../components/DataStates.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, CopyButton, DataTable, DetailDrawer, SearchField, Tabs } from '../components/ui/index.ts';
import type { DataTableColumn, TabItem } from '../components/ui/index.ts';
import { isFamilyLoading, shownFamilyCountLabel } from '../lib/inventoryDisplay.ts';
import { filterByQuery, sameName } from '../lib/inventory.ts';
import type { FocusObject } from '../lib/objectDetail.ts';
import { findCapability, resourceStatusMessage } from '../lib/resourceStatus.ts';
import {
  streamDataSpace,
  streamDateText,
  streamRowKey,
  streamSearchValues,
  streamStatusTone,
  streamTargetKnown,
  streamValue,
} from '../lib/streamDetail.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

interface DataStreamExplorerProps {
  context: WorkspaceContext | null;
  focusObject?: FocusObject | null;
  onFocusHandled?: () => void;
}

function OverviewField({ label, value, hint, mono = false }: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-alt p-3">
      <p className="label-xs">{label}</p>
      <p
        title={value}
        className={`mt-1 text-sm text-ink ${mono ? 'mono break-all' : 'break-words'}`}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

function StreamDetail({ stream, inventory, onClose }: {
  stream: DataStream;
  inventory: InventorySnapshot;
  onClose: () => void;
}) {
  const target = inventory.dlos.find((dlo) => sameName(dlo.apiName, stream.targetDlo)) ?? null;
  const dataSpace = streamDataSpace(inventory, stream);
  const targetKnown = streamTargetKnown(inventory, stream);
  const mappings = stream.targetDlo
    ? inventory.mappings.filter((mapping) =>
        sameName(mapping.sourceObject, stream.targetDlo) || sameName(mapping.targetObject, stream.targetDlo))
    : [];
  const rawMetadata = JSON.stringify(stream, null, 2);
  const sourceLabel = streamValue(stream.sourceConnectorLabel ?? stream.sourceConnector, 'Not provided');
  const sourceHint = stream.sourceConnector && stream.sourceConnector !== sourceLabel
    ? `Connector type: ${stream.sourceConnector}`
    : undefined;
  const connectionValue = streamValue(
    stream.sourceConnectionLabel ?? stream.sourceConnectionName ?? stream.sourceDataSource,
    'Not available from this snapshot',
  );
  const connectionHint = [
    stream.sourceConnectionStatus,
    stream.sourceConnectionName && stream.sourceConnectionName !== connectionValue
      ? stream.sourceConnectionName
      : null,
  ].filter(Boolean).join(' · ') || undefined;

  const tabs: TabItem[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <OverviewField label="Source connector" value={sourceLabel} hint={sourceHint} />
            <OverviewField
              label="Configured connection"
              value={connectionValue}
              hint={connectionHint}
            />
            <OverviewField label="Stream status" value={streamValue(stream.status, 'Status unknown')} />
            <OverviewField label="Refresh metadata" value={streamValue(stream.refreshMetadata, 'Not provided')} />
            <OverviewField label="Target DLO" value={streamValue(stream.targetDlo, 'Not named by source metadata')} mono />
            <OverviewField
              label="Data space"
              value={dataSpace ?? 'Not available from this snapshot'}
            />
            <OverviewField label="API name" value={stream.apiName} mono />
          </div>

          <div className="rounded-lg border border-line p-4">
            <p className="label-xs">Provenance</p>
            <dl className="mt-2 grid gap-1.5 text-xs text-ink-soft">
              <div className="flex min-w-0 justify-between gap-3">
                <dt className="shrink-0">Endpoint</dt>
                <dd className="mono min-w-0 break-all text-right">{stream.provenance.sourceEndpoint}</dd>
              </div>
              <div className="flex justify-between gap-3"><dt>API version</dt><dd>{stream.provenance.apiVersion}</dd></div>
              <div className="flex justify-between gap-3"><dt>Confidence</dt><dd>{stream.provenance.confidence}</dd></div>
              {stream.connectorLookup ? (
                <div className="flex justify-between gap-3">
                  <dt>Connector lookup</dt>
                  <dd>{stream.connectorLookup.endpoints.length} endpoint(s) · v{stream.connectorLookup.apiVersion}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3"><dt>Retrieved</dt><dd>{streamDateText(stream.provenance.retrievedAt)}</dd></div>
            </dl>
          </div>

          <p className="text-xs text-ink-soft">
            Data space comes from stream metadata when Salesforce supplies it; otherwise it is joined from the target DLO in this snapshot.
          </p>
        </div>
      ),
    },
    {
      id: 'target',
      label: 'Target DLO',
      content: (
        <div className="space-y-4">
          {target ? (
            <div className="min-w-0 rounded-lg border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-semibold text-ink">{target.label ?? target.apiName}</p>
                  <p className="mono mt-1 break-all text-ink-faint">{target.apiName}</p>
                </div>
                <Badge tone="success" dot>Known in inventory</Badge>
              </div>
              <dl className="mt-3 grid gap-1.5 text-xs text-ink-soft sm:grid-cols-2">
                <div className="flex min-w-0 justify-between gap-3"><dt>Data space</dt><dd className="break-words text-right">{streamValue(target.dataSpace, 'Not provided')}</dd></div>
                <div className="flex justify-between gap-3"><dt>Fields</dt><dd>{target.fields.length}</dd></div>
              </dl>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-surface-alt p-4">
              <Badge tone={targetKnown ? 'brand' : 'neutral'} dot>
                {targetKnown ? 'Resolved in this snapshot' : 'Referenced by metadata only'}
              </Badge>
              <p className="mono mt-2 break-all text-sm text-ink">{streamValue(stream.targetDlo, 'No target DLO was returned.')}</p>
              <p className="mt-2 text-xs text-ink-soft">
                DCAT does not invent the target object, its fields, or its data space when the object is absent from the inventory.
              </p>
            </div>
          )}

          <div>
            <p className="label-xs">Mappings using this target ({mappings.length})</p>
            {mappings.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No mappings in this snapshot name that object.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {mappings.map((mapping, index) => (
                  <li key={`${mapping.apiName}-${index}`} className="min-w-0 rounded-lg border border-line bg-surface-alt px-3 py-2.5">
                    <p className="mono break-all text-sm text-ink">{mapping.apiName}</p>
                    <p className="mt-1 break-all text-xs text-ink-soft">
                      {streamValue(mapping.sourceObject, 'Unknown source')} → {streamValue(mapping.targetObject, 'Unknown target')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-ink-soft">
            Links are derived from names in the current snapshot. No stream lineage is inferred from similar names.
          </p>
        </div>
      ),
    },
    {
      id: 'raw',
      label: 'Raw Metadata',
      content: (
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-alt p-3 text-xs text-ink-soft">
          {rawMetadata}
        </pre>
      ),
    },
  ];

  return (
    <DetailDrawer
      open
      title={streamValue(stream.label, stream.apiName)}
      subtitle={stream.apiName}
      breadcrumbs={`Data Stream Explorer / ${streamValue(stream.label, stream.apiName)}`}
      headerActions={
        <>
          <Badge tone="neutral">Read-only</Badge>
          <CopyButton value={stream.apiName} label="Copy API name" />
          <CopyButton value={rawMetadata} label="Copy metadata JSON" icon="book" />
        </>
      }
      onClose={onClose}
    >
      <Tabs key={streamRowKey(stream)} items={tabs} label="Data stream detail sections" />
    </DetailDrawer>
  );
}

export function DataStreamExplorer({ context, focusObject, onFocusHandled }: DataStreamExplorerProps) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const focusHandledRef = useRef(onFocusHandled);
  focusHandledRef.current = onFocusHandled;

  useEffect(() => {
    if (!focusObject || focusObject.kind !== 'stream' || !query.isSuccess) return;
    const stream = query.data?.dataStreams.find((entry) => entry.apiName === focusObject.apiName);
    if (stream) {
      setSelectedKey(streamRowKey(stream));
      setSearch('');
      setStatusFilter('all');
    }
    focusHandledRef.current?.();
  }, [focusObject, query.isSuccess, query.data]);

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const capability = findCapability(inventory, 'data-streams');
        const statusOptions = [...new Set(
          inventory.dataStreams.map((stream) => streamValue(stream.status, 'Status unknown')),
        )].sort((left, right) => left.localeCompare(right));
        const streams = filterByQuery(inventory.dataStreams, search, (stream) =>
          streamSearchValues(inventory, stream),
        ).filter((stream) => statusFilter === 'all' || streamValue(stream.status, 'Status unknown') === statusFilter);
        const selected = inventory.dataStreams.find((stream) => streamRowKey(stream) === selectedKey) ?? null;

        const download = (format: 'csv' | 'json' | 'markdown') => {
          if (format === 'csv') {
            const contents = exportCsvTable(
              [
                'API name',
                'Label',
                'Source connector',
                'Source connector label',
                'Configured connection',
                'Target DLO',
                'Data space',
                'Status',
                'Refresh metadata',
                'Source endpoint',
                'Retrieved at',
                'Confidence',
              ],
              streams.map((stream) => [
                stream.apiName,
                stream.label,
                stream.sourceConnector,
                stream.sourceConnectorLabel,
                stream.sourceConnectionLabel ?? stream.sourceConnectionName ?? stream.sourceDataSource,
                stream.targetDlo,
                streamDataSpace(inventory, stream),
                stream.status,
                stream.refreshMetadata,
                stream.provenance.sourceEndpoint,
                stream.provenance.retrievedAt,
                stream.provenance.confidence,
              ]),
            );
            downloadTextFile(`dcat-streams-${inventory.org.alias}.csv`, contents, 'text/csv');
          } else if (format === 'markdown') {
            downloadTextFile(
              `dcat-inventory-${inventory.org.alias}.md`,
              exportInventoryMarkdown(inventory),
              'text/markdown',
            );
          } else {
            downloadTextFile(
              `dcat-inventory-${inventory.org.alias}.json`,
              exportInventoryJson(inventory),
              'application/json',
            );
          }
          setExportMessage(`${format === 'markdown' ? 'Markdown' : format.toUpperCase()} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          { id: 'csv', label: 'CSV', description: 'Visible streams', icon: 'download', onSelect: () => download('csv') },
          { id: 'json', label: 'JSON', description: 'Complete machine-readable inventory', icon: 'layers', onSelect: () => download('json') },
          { id: 'markdown', label: 'Markdown', description: 'Architecture documentation', icon: 'book', onSelect: () => download('markdown') },
        ];

        const columns: DataTableColumn<DataStream>[] = [
          {
            key: 'stream',
            header: 'Stream',
            render: (stream) => (
              <div className="min-w-0">
                <p className="break-words font-medium text-ink">{streamValue(stream.label, stream.apiName)}</p>
                <p className="mono mt-0.5 break-all text-ink-faint">{stream.apiName}</p>
              </div>
            ),
          },
          {
            key: 'connector',
            header: 'Source connector',
            hideBelow: 'md',
            render: (stream) => <span className="break-words text-sm text-ink-soft">{streamValue(stream.sourceConnector)}</span>,
          },
          {
            key: 'target',
            header: 'Target DLO',
            render: (stream) => (
              <div className="min-w-0">
                <p className="mono break-all text-ink">{streamValue(stream.targetDlo, 'Not named')}</p>
                <Badge tone={streamTargetKnown(inventory, stream) ? 'success' : 'neutral'} dot>
                  {streamTargetKnown(inventory, stream) ? 'Known in inventory' : 'Referenced by metadata only'}
                </Badge>
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            hideBelow: 'sm',
            render: (stream) => <Badge tone={streamStatusTone(stream.status)}>{streamValue(stream.status, 'Status unknown')}</Badge>,
          },
          {
            key: 'refresh',
            header: 'Refresh metadata',
            hideBelow: 'lg',
            render: (stream) => <span className="break-words text-sm text-ink-soft">{streamValue(stream.refreshMetadata)}</span>,
          },
          {
            key: 'action',
            header: <span className="sr-only">Actions</span>,
            render: (stream) => (
              <Button variant="quiet" onClick={() => setSelectedKey(streamRowKey(stream))} className="px-2 py-1 text-xs">
                Details
              </Button>
            ),
          },
        ];

        return (
          <>
            <ExportNotice mode={context?.mode ?? 'demo'} />
            <PageIntro
              title="Data Stream Explorer"
              description="Find a stream and inspect its source connector, target object, status, cadence, and provenance."
              actions={
                <>
                  <div className="w-full sm:w-64">
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      placeholder="Search streams or connectors"
                      label="Search data streams"
                    />
                  </div>
                  <label className="w-full sm:w-44">
                    <span className="sr-only">Filter by status</span>
                    <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input h-9 py-1.5">
                      <option value="all">All statuses</option>
                      {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{shownFamilyCountLabel(inventory, 'data-streams', streams.length, inventory.dataStreams.length, 'streams')}</Badge>}
            />
            {exportMessage ? <p className="mb-4 text-xs text-ink-soft" role="status">{exportMessage}</p> : null}

            {capability && capability.status !== 'available' && capability.status !== 'not-started' ? (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-ink-soft" role="note">
                <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-warning" />
                <span className="min-w-0 break-words">
                  {resourceStatusMessage(capability)} Any streams below come from the inventory snapshot and are not invented by DCAT.
                </span>
              </div>
            ) : null}

            {streams.length === 0 ? (
              <EmptyState
                title={
                  capability?.status === 'forbidden' ? 'Access denied to Data Streams'
                    : capability?.status === 'unsupported' ? 'Data Streams are unavailable'
                      : capability?.status === 'error' ? 'Could not load Data Streams'
                        : capability?.status === 'partial' ? 'Some Data Streams may be missing'
                          : isFamilyLoading(inventory, 'data-streams') ? 'Data Streams are still loading'
                            : 'No data streams found'
                }
                description={isFamilyLoading(inventory, 'data-streams')
                  ? 'Batches are still arriving; this result is not final yet.'
                  : capability && capability.status !== 'available' && capability.status !== 'not-started'
                    ? resourceStatusMessage(capability)
                    : 'No streams match this search and status filter for the current org.'}
                icon="stream"
              />
            ) : (
              <>
                <div className="grid gap-2 md:hidden">
                  {streams.map((stream) => (
                    <button
                      key={streamRowKey(stream)}
                      type="button"
                      onClick={() => setSelectedKey(streamRowKey(stream))}
                      className="panel w-full p-4 text-left"
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-ink">{streamValue(stream.label, stream.apiName)}</p>
                          <p className="mono mt-1 break-all text-ink-faint">{stream.apiName}</p>
                        </div>
                        <Icon name="arrowRight" size={16} className="text-ink-faint" />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                        <Badge tone={streamStatusTone(stream.status)}>{streamValue(stream.status, 'Status unknown')}</Badge>
                        <span className="min-w-0 break-words">{streamValue(stream.sourceConnector)}</span>
                        <span className="min-w-0 break-all">{streamValue(stream.targetDlo, 'No target')}</span>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="panel hidden overflow-hidden md:block">
                  <DataTable
                    columns={columns}
                    rows={streams}
                    getRowKey={streamRowKey}
                    ariaLabel="Data Stream Explorer results"
                  />
                </div>
              </>
            )}

            {context && selected ? (
              <StreamDetail stream={selected} inventory={inventory} onClose={() => setSelectedKey(null)} />
            ) : null}
          </>
        );
      }}
    </InventoryBoundary>
  );
}
