import { useEffect, useRef, useState } from 'react';
import type { DataTransform, InventorySnapshot, RetrievalStatus, TransformRun } from '@dcat/core';
import { downloadTextFile, exportCsvTable, exportInventoryJson, exportInventoryMarkdown } from '@dcat/exporters';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, CopyButton, DataTable, DetailDrawer, SearchField, Tabs } from '../components/ui/index.ts';
import type { DataTableColumn, TabItem } from '../components/ui/index.ts';
import { isFamilyLoading, shownFamilyCountLabel } from '../lib/inventoryDisplay.ts';
import { filterByQuery, safeDateText } from '../lib/inventory.ts';
import type { FocusObject } from '../lib/objectDetail.ts';
import { findCapability, resourceStatusMessage } from '../lib/resourceStatus.ts';
import { useInventory } from '../lib/useInventory.ts';
import { useTransformBundle } from '../lib/useTransforms.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

interface DataTransformExplorerProps {
  context: WorkspaceContext | null;
  focusObject?: FocusObject | null;
  onFocusHandled?: () => void;
}

function transformId(transform: DataTransform): string {
  return transform.id ?? transform.apiName;
}

function shown(value: string | null | undefined, fallback = 'Not provided'): string {
  return value && value.trim() ? value : fallback;
}

function typeTone(type: string | null | undefined): 'brand' | 'neutral' {
  return type?.toLowerCase() === 'streaming' ? 'brand' : 'neutral';
}

function SectionMessage({ status, message, empty }: { status: RetrievalStatus; message?: string | null; empty: string }) {
  if (status === 'forbidden') {
    return <p className="text-sm text-danger">Access denied. {shown(message, '')}</p>;
  }
  if (status === 'unsupported') {
    return <p className="text-sm text-ink-soft">This metadata endpoint is unavailable for this org or API version. {shown(message, '')}</p>;
  }
  if (status === 'error') {
    return <p className="text-sm text-danger">This section could not be loaded. {shown(message, '')}</p>;
  }
  if (status === 'not-started') {
    return <p className="text-sm text-ink-soft">This section has not been requested yet.</p>;
  }
  return <p className="text-sm text-ink-soft">{empty}</p>;
}

function OverviewField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-alt p-3">
      <p className="label-xs">{label}</p>
      <p className={`mt-1 text-sm text-ink ${mono ? 'mono break-all' : ''}`}>{value}</p>
    </div>
  );
}

function ObjectRefList({ values, objects, empty }: {
  values: string[] | null | undefined;
  objects: Array<{ apiName: string; label?: string | null; dataSpace?: string | null }>;
  empty: string;
}) {
  if (!values || values.length === 0) return <p className="text-sm text-ink-soft">{empty}</p>;
  return (
    <ul className="space-y-2">
      {values.map((value) => {
        const match = objects.find((object) => object.apiName === value);
        return (
          <li key={value} className="rounded-lg border border-line bg-surface-alt px-3 py-2.5">
            <p className="mono text-sm text-ink">{value}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
              <Badge tone={match ? 'success' : 'neutral'} dot>
                {match ? 'Known in inventory' : 'Referenced by transform metadata only'}
              </Badge>
              {match?.label ? <span>{match.label}</span> : null}
              {match?.dataSpace ? <span className="mono">{match.dataSpace}</span> : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function runColumns(): DataTableColumn<TransformRun>[] {
  return [
    {
      key: 'run',
      header: 'Run',
      render: (run) => (
        <div className="min-w-0">
          <p className="mono text-ink">{run.id}</p>
          {run.message ? <p className="mt-0.5 text-xs text-ink-soft">{run.message}</p> : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (run) => <Badge tone={run.status ? 'brand' : 'neutral'}>{shown(run.status, 'Unknown')}</Badge>,
    },
    { key: 'started', header: 'Started', hideBelow: 'md', render: (run) => safeDateText(run.startedAt) },
    { key: 'ended', header: 'Ended', hideBelow: 'lg', render: (run) => safeDateText(run.endedAt) },
    {
      key: 'duration',
      header: 'Duration',
      hideBelow: 'lg',
      align: 'end',
      render: (run) => typeof run.durationMs === 'number' ? `${run.durationMs} ms` : '-',
    },
    {
      key: 'records',
      header: 'Records',
      align: 'end',
      render: (run) => typeof run.recordsProcessed === 'number' ? run.recordsProcessed.toLocaleString() : '-',
    },
  ];
}

interface TransformDetailProps {
  context: WorkspaceContext;
  transform: DataTransform;
  inventory: InventorySnapshot;
  onClose: () => void;
}

function TransformDetail({ context, transform, inventory, onClose }: TransformDetailProps) {
  const id = transformId(transform);
  const bundleQuery = useTransformBundle(context, id);
  const bundle = bundleQuery.data;
  const detail = bundle?.transform ?? transform;
  const runs = bundle?.runs ?? [];
  const schedule = bundle?.schedule ?? null;
  const sections = bundle?.sections ?? {
    detail: 'not-started' as RetrievalStatus,
    runHistory: 'not-started' as RetrievalStatus,
    schedule: 'not-started' as RetrievalStatus,
  };
  const messages = bundle?.messages ?? { detail: null, runHistory: null, schedule: null };
  const knownObjects: InventorySnapshot['dlos'] | InventorySnapshot['dmos'] = [
    ...inventory.dlos,
    ...inventory.dmos,
  ];
  const rawMetadata = detail.raw ?? detail;

  const tabs: TabItem[] = [
    {
      id: 'overview',
      label: 'Overview',
      content: (
        <div className="space-y-5">
          {sections.detail === 'forbidden' || sections.detail === 'unsupported' || sections.detail === 'error' ? (
            <p className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-ink-soft">
              <strong>Detail endpoint:</strong> {shown(messages.detail, resourceStatusMessage({
                family: 'data-transforms',
                status: sections.detail,
                endpoint: detail.provenance.sourceEndpoint,
              }))}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <OverviewField label="Transform status" value={shown(detail.status, 'Unknown')} />
            <OverviewField label="Last run status" value={shown(detail.lastRunStatus, 'No run data')} />
            <OverviewField label="Type" value={shown(detail.type, 'Not provided')} />
            <OverviewField label="Transform ID" value={shown(detail.id ?? null, 'Not provided')} mono />
            <OverviewField label="Data space" value={shown(detail.dataSpace, 'Not provided')} />
            <OverviewField label="Schedule / cadence" value={shown(schedule?.cadence ?? detail.schedule, 'No schedule data returned')} />
            <OverviewField label="Owner" value={shown(detail.owner, 'Not provided')} />
            <OverviewField label="Created" value={safeDateText(detail.createdAt)} />
            <OverviewField label="Modified" value={safeDateText(detail.modifiedAt)} />
            <OverviewField label="Last run" value={safeDateText(detail.lastRunAt ?? schedule?.lastRunAt)} />
          </div>

          <div>
            <p className="label-xs">Description</p>
            <p className="mt-1 text-sm text-ink-soft">{shown(detail.description, 'No description was returned by the source metadata.')}</p>
          </div>

          <div className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">Schedule</p>
              <Badge tone="neutral">Read-only</Badge>
            </div>
            <dl className="mt-3 grid gap-2 text-xs text-ink-soft sm:grid-cols-2">
              <div className="flex justify-between gap-3"><dt>Enabled</dt><dd>{schedule?.enabled === true ? 'Yes' : schedule?.enabled === false ? 'No' : 'Not provided'}</dd></div>
              <div className="flex justify-between gap-3"><dt>Timezone</dt><dd>{shown(schedule?.timezone)}</dd></div>
              <div className="flex justify-between gap-3"><dt>Next run</dt><dd>{safeDateText(schedule?.nextRunAt)}</dd></div>
              <div className="flex justify-between gap-3"><dt>Last run</dt><dd>{safeDateText(schedule?.lastRunAt)}</dd></div>
            </dl>
            {sections.schedule === 'unsupported' || sections.schedule === 'forbidden' || sections.schedule === 'error' ? (
              <p className="mt-3 text-xs text-ink-soft">
                <strong>Schedule endpoint:</strong> {shown(messages.schedule, 'No schedule detail was returned.')}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-line p-4">
            <p className="label-xs">Provenance</p>
            <dl className="mt-2 grid gap-1.5 text-xs text-ink-soft">
              <div className="flex justify-between gap-3"><dt>Endpoint</dt><dd className="mono truncate">{detail.provenance.sourceEndpoint}</dd></div>
              <div className="flex justify-between gap-3"><dt>API version</dt><dd>{detail.provenance.apiVersion}</dd></div>
              <div className="flex justify-between gap-3"><dt>Confidence</dt><dd>{detail.provenance.confidence}</dd></div>
              <div className="flex justify-between gap-3"><dt>Retrieved</dt><dd>{safeDateText(detail.provenance.retrievedAt)}</dd></div>
            </dl>
          </div>
        </div>
      ),
    },
    {
      id: 'lineage',
      label: 'Flow & Lineage',
      content: (
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <p className="label-xs mb-2">Inputs</p>
            <ObjectRefList
              values={detail.inputs}
              objects={knownObjects}
              empty="No input objects were returned by the source metadata."
            />
          </div>
          <div>
            <p className="label-xs mb-2">Outputs</p>
            <ObjectRefList
              values={detail.outputs}
              objects={knownObjects}
              empty="No output objects were returned by the source metadata."
            />
          </div>
          <p className="text-xs text-ink-soft md:col-span-2">
            Links are shown only when the transform metadata names an object. No lineage is inferred from naming patterns.
          </p>
        </div>
      ),
    },
    {
      id: 'definition',
      label: 'Definition',
      content: shown(detail.definition, '') ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="label-xs">Source definition (read-only)</p>
            <Badge tone="neutral">Read-only</Badge>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-alt p-4 text-xs text-ink-soft">
            {detail.definition}
          </pre>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">No transform definition was returned by this org or API version.</p>
      ),
    },
    {
      id: 'runs',
      label: `Run History (${runs.length})`,
      content: sections.runHistory === 'available' || sections.runHistory === 'partial' ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <DataTable
            columns={runColumns()}
            rows={runs}
            getRowKey={(run) => run.id}
            ariaLabel="Transform run history"
            emptyMessage="No runs were returned for this transform."
          />
        </div>
      ) : (
        <SectionMessage
          status={sections.runHistory}
          message={messages.runHistory}
          empty="No runs were returned for this transform."
        />
      ),
    },
    {
      id: 'raw',
      label: 'Raw Metadata',
      content: (
        <pre className="overflow-x-auto rounded-lg border border-line bg-surface-alt p-3 text-xs text-ink-soft">
          {JSON.stringify(rawMetadata, null, 2)}
        </pre>
      ),
    },
  ];

  return (
    <DetailDrawer
      open
      title={detail.label ?? detail.apiName}
      subtitle={detail.apiName}
      breadcrumbs={`Data Transform Explorer / ${detail.label ?? detail.apiName}`}
      headerActions={
        <>
          <Badge tone="neutral">Read-only</Badge>
          <CopyButton value={detail.apiName} label="Copy API name" />
          {detail.id ? <CopyButton value={detail.id} label="Copy transform ID" icon="info" /> : null}
          <CopyButton value={JSON.stringify(rawMetadata, null, 2)} label="Copy metadata JSON" icon="book" />
        </>
      }
      onClose={onClose}
    >
      {bundleQuery.isPending ? <LoadingState label="Loading transform detail..." /> : null}
      {bundleQuery.isError ? (
        <ErrorState
          title="Couldn't load transform detail"
          message={bundleQuery.error.message}
          onRetry={() => void bundleQuery.refetch()}
        />
      ) : null}
      {bundleQuery.isSuccess ? <Tabs items={tabs} label="Data transform detail sections" /> : null}
    </DetailDrawer>
  );
}

export function DataTransformExplorer({ context, focusObject, onFocusHandled }: DataTransformExplorerProps) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [selectedApiName, setSelectedApiName] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const focusHandledRef = useRef(onFocusHandled);
  focusHandledRef.current = onFocusHandled;

  useEffect(() => {
    if (!focusObject || focusObject.kind !== 'transform' || !query.isSuccess) return;
    const transform = query.data?.dataTransforms.find((entry) => entry.apiName === focusObject.apiName);
    if (transform) {
      setSelectedApiName(transform.apiName);
      setSearch('');
      setType('all');
    }
    focusHandledRef.current?.();
  }, [focusObject, query.isSuccess, query.data]);

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const capability = findCapability(inventory, 'data-transforms');
        const transforms = filterByQuery(inventory.dataTransforms, search, (transform) => [
          transform.label ?? '',
          transform.apiName,
          transform.status ?? '',
          transform.type ?? '',
          transform.lastRunStatus ?? '',
          transform.description ?? '',
          transform.dataSpace ?? '',
        ]).filter((transform) => type === 'all' || transform.type?.toLowerCase() === type);
        const selected = inventory.dataTransforms.find((transform) => transform.apiName === selectedApiName) ?? null;

        const download = (format: 'csv' | 'json' | 'markdown') => {
          if (format === 'csv') {
            const contents = exportCsvTable(
              ['Transform ID', 'API name', 'Label', 'Type', 'Transform status', 'Last run status', 'Last run at', 'Data space', 'Source endpoint'],
              transforms.map((transform) => [
                transform.id,
                transform.apiName,
                transform.label,
                transform.type,
                transform.status,
                transform.lastRunStatus,
                transform.lastRunAt,
                transform.dataSpace,
                transform.provenance.sourceEndpoint,
              ]),
            );
            downloadTextFile(`dcat-transforms-${inventory.org.alias}.csv`, contents, 'text/csv');
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
          { id: 'csv', label: 'CSV', description: 'Visible transforms', icon: 'download', onSelect: () => download('csv') },
          { id: 'json', label: 'JSON', description: 'Current snapshot', icon: 'download', onSelect: () => download('json') },
          { id: 'markdown', label: 'Markdown', description: 'Architecture summary', icon: 'book', onSelect: () => download('markdown') },
        ];

        const columns: DataTableColumn<DataTransform>[] = [
          {
            key: 'transform',
            header: 'Transform',
            render: (transform) => (
              <div className="min-w-0">
                <p className="font-medium text-ink">{transform.label ?? transform.apiName}</p>
                <p className="mono mt-0.5 text-ink-faint">{transform.apiName}</p>
                {transform.description ? <p className="mt-1 truncate text-xs text-ink-soft">{transform.description}</p> : null}
              </div>
            ),
          },
          {
            key: 'type',
            header: 'Type',
            render: (transform) => <Badge tone={typeTone(transform.type)}>{shown(transform.type, 'Unknown')}</Badge>,
          },
          {
            key: 'status',
            header: 'Transform status',
            hideBelow: 'sm',
            render: (transform) => <Badge tone="neutral">{shown(transform.status, 'Unknown')}</Badge>,
          },
          {
            key: 'lastRun',
            header: 'Last run',
            hideBelow: 'md',
            render: (transform) => (
              <div>
                <p className="text-sm text-ink">{shown(transform.lastRunStatus, 'No run data')}</p>
                {transform.lastRunAt ? <p className="text-xs text-ink-faint">{safeDateText(transform.lastRunAt)}</p> : null}
              </div>
            ),
          },
          {
            key: 'action',
            header: <span className="sr-only">Actions</span>,
            render: (transform) => (
              <Button variant="quiet" onClick={() => setSelectedApiName(transform.apiName)} className="px-2 py-1 text-xs">
                Details
              </Button>
            ),
          },
        ];

        return (
          <>
            <ExportNotice mode={context?.mode ?? 'demo'} />
            <PageIntro
              title="Data Transform Explorer"
              description="Inspect batch and streaming transforms, their inputs and outputs, definitions, and available run history."
              actions={
                <>
                  <div className="w-full sm:w-64">
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      placeholder="Search transforms"
                      label="Search data transforms"
                    />
                  </div>
                  <label className="w-full sm:w-44">
                    <span className="sr-only">Filter by transform type</span>
                    <select value={type} onChange={(event) => setType(event.target.value)} className="input h-9 py-1.5">
                      <option value="all">All types</option>
                      <option value="batch">Batch</option>
                      <option value="streaming">Streaming</option>
                    </select>
                  </label>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{shownFamilyCountLabel(inventory, 'data-transforms', transforms.length, inventory.dataTransforms.length, 'transforms')}</Badge>}
            />
            {exportMessage ? <p className="mb-4 text-xs text-ink-soft" role="status">{exportMessage}</p> : null}

            {capability && (capability.status === 'error' || capability.status === 'forbidden' || capability.status === 'unsupported') ? (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-ink-soft" role="note">
                <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-warning" />
                <span>{resourceStatusMessage(capability)} Any records below come from the inventory snapshot and are not invented by DCAT.</span>
              </div>
            ) : null}

            {transforms.length === 0 ? (
              <EmptyState
                title={capability?.status === 'forbidden' ? 'Access denied to Data Transforms' : (
                  capability?.status === 'unsupported' ? 'Data Transforms are unavailable'
                    : isFamilyLoading(inventory, 'data-transforms') ? 'Data Transforms are still loading'
                      : 'No data transforms found'
                )}
                description={isFamilyLoading(inventory, 'data-transforms')
                  ? 'Batches are still arriving; this result is not final yet.'
                  : capability && capability.status !== 'available'
                    ? resourceStatusMessage(capability)
                    : 'No transforms were returned for this org or API version. Detail and run-history endpoints remain unavailable until metadata is present.'}
                icon="sparkles"
              />
            ) : (
              <>
                <div className="grid gap-2 md:hidden">
                  {transforms.map((transform) => (
                    <button
                      key={transformId(transform)}
                      type="button"
                      onClick={() => setSelectedApiName(transform.apiName)}
                      className="panel w-full p-4 text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">{transform.label ?? transform.apiName}</p>
                          <p className="mono mt-1 truncate text-ink-faint">{transform.apiName}</p>
                        </div>
                        <Icon name="arrowRight" size={16} className="text-ink-faint" />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                        <Badge tone={typeTone(transform.type)}>{shown(transform.type, 'Unknown')}</Badge>
                        <Badge tone="neutral">{shown(transform.status, 'Status unknown')}</Badge>
                        <span>{shown(transform.lastRunStatus, 'No run data')}</span>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="panel hidden overflow-hidden md:block">
                  <DataTable
                    columns={columns}
                    rows={transforms}
                    getRowKey={transformId}
                    ariaLabel="Data Transform Explorer results"
                  />
                </div>
              </>
            )}

            {context && selected ? (
              <TransformDetail
                context={context}
                transform={selected}
                inventory={inventory}
                onClose={() => setSelectedApiName(null)}
              />
            ) : null}
          </>
        );
      }}
    </InventoryBoundary>
  );
}
