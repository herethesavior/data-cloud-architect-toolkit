import { useEffect, useRef, useState } from 'react';
import type { DataField } from '@dcat/core';
import {
  downloadTextFile,
  exportCsvTable,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import { filterByQuery, safeDateText } from '../lib/inventory.ts';
import { objectLinks, objectMarkdown } from '../lib/objectDetail.ts';
import type { ExplorerObject, FocusObject } from '../lib/objectDetail.ts';
import { findCapability, resourceStatusMessage } from '../lib/resourceStatus.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import { EmptyState } from './DataStates.tsx';
import { ExportMenu } from './ExportMenu.tsx';
import type { ExportMenuItem } from './ExportMenu.tsx';
import { ExportNotice } from './ExportNotice.tsx';
import { InventoryBoundary } from './InventoryBoundary.tsx';
import { Icon } from './Icon.tsx';
import { PageIntro } from './PageIntro.tsx';
import { navigateFromLink } from './AppShell.tsx';
import { pageHref, pagePath } from '../navigation.ts';
import { Badge, Button, CopyButton, DataTable, DetailDrawer, SearchField, Tabs } from './ui/index.ts';
import type { DataTableColumn, TabItem } from './ui/index.ts';

interface ObjectExplorerProps {
  context: WorkspaceContext | null;
  kind: 'dlo' | 'dmo';
  focusObject?: FocusObject | null;
  onFocusHandled?: () => void;
  onNavigate?: (page: import('../navigation.ts').Page) => void;
}

const formatLabels = { csv: 'CSV', json: 'JSON', markdown: 'Markdown' } as const;

const fieldColumns: DataTableColumn<DataField>[] = [
  {
    key: 'field',
    header: 'Field',
    render: (field) => (
      <div className="min-w-0">
        <p className="mono font-medium text-ink">{field.apiName}</p>
        {field.description ? <p className="mt-0.5 text-xs text-ink-soft">{field.description}</p> : null}
      </div>
    ),
  },
  { key: 'label', header: 'Label', render: (field) => field.label ?? '—' },
  { key: 'type', header: 'Type', render: (field) => <span className="mono">{field.dataType ?? '—'}</span> },
  {
    key: 'key',
    header: 'Key',
    render: (field) => (field.isPrimaryKey ? <Badge tone="brand">Primary</Badge> : <span className="text-ink-faint">—</span>),
  },
];

function objectCategory(object: ExplorerObject, kind: 'dlo' | 'dmo'): string {
  if (kind === 'dmo') {
    const custom = 'isCustom' in object && object.isCustom;
    return custom ? 'Custom DMO' : object.category ?? 'DMO';
  }
  return 'source' in object ? object.source ?? object.category ?? '—' : '—';
}

function objectSummary(object: ExplorerObject): string {
  return [
    object.apiName,
    object.label ?? '',
    object.category ?? '',
    object.dataSpace ?? '',
    ...object.fields.flatMap((field) => [field.apiName, field.label ?? '', field.description ?? '']),
  ].join(' ');
}

export function ObjectExplorer({ context, kind, focusObject, onFocusHandled, onNavigate }: ObjectExplorerProps) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [space, setSpace] = useState('all');
  const [selected, setSelected] = useState<ExplorerObject | null>(null);
  const [message, setMessage] = useState('');
  const focusHandledRef = useRef(onFocusHandled);
  focusHandledRef.current = onFocusHandled;

  // Global search can ask this explorer to open a drawer after navigation. Wait
  // for the scoped inventory so the object is matched only in the active context.
  useEffect(() => {
    if (!focusObject || focusObject.kind !== kind || !query.isSuccess) return;
    const objects = kind === 'dlo' ? query.data?.dlos ?? [] : query.data?.dmos ?? [];
    const object = objects.find((entry) => entry.apiName === focusObject.apiName) ?? null;
    if (object) {
      setSelected(object);
      setSearch('');
      setSpace('all');
    }
    focusHandledRef.current?.();
  }, [focusObject, kind, query.isSuccess, query.data]);

  const isDlo = kind === 'dlo';
  const title = isDlo ? 'DLO Explorer' : 'DMO Explorer';
  const description = isDlo
    ? 'Search Data Lake Objects and inspect the fields ingested into Data 360.'
    : 'Search Data Model Objects and inspect the unified fields available to your team.';

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const objects: ExplorerObject[] = isDlo ? inventory.dlos : inventory.dmos;
        const capability = findCapability(inventory, isDlo ? 'dlos' : 'dmos');
        const linksFor = (object: ExplorerObject) => objectLinks(inventory, object);
        const spaces = [...new Set(objects.map((object) => object.dataSpace).filter((value): value is string => Boolean(value)))].sort();
        const activeSpace = spaces.includes(space) ? space : 'all';
        const filtered = filterByQuery(objects, search, (object) => [objectSummary(object)]).filter(
          (object) => activeSpace === 'all' || object.dataSpace === activeSpace,
        );

        const download = (format: keyof typeof formatLabels, contents: string, extension: string, mimeType: string) => {
          downloadTextFile(`dcat-${isDlo ? 'dlos' : 'dmos'}-${inventory.org.alias}.${extension}`, contents, mimeType);
          setMessage(`${formatLabels[format]} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          {
            id: 'csv',
            label: 'CSV',
            description: 'Visible objects and fields',
            icon: 'database',
            onSelect: () => download('csv', exportCsvTable(
              ['Object type', 'Object API name', 'Object label', 'Data space', 'Category / source', 'Field API name', 'Field label', 'Description', 'Data type', 'Primary key'],
              filtered.flatMap((object) => {
                const fields = object.fields.length > 0 ? object.fields : [null];
                return fields.map((field) => [
                  isDlo ? 'DLO' : 'DMO',
                  object.apiName,
                  object.label ?? object.apiName,
                  object.dataSpace,
                  objectCategory(object, kind),
                  field?.apiName,
                  field?.label,
                  field?.description,
                  field?.dataType,
                  field ? (field.isPrimaryKey ? 'Yes' : 'No') : null,
                ]);
              }),
            ), 'csv', 'text/csv'),
          },
          {
            id: 'json',
            label: 'JSON',
            description: 'Complete machine-readable inventory',
            icon: 'layers',
            onSelect: () => download('json', exportInventoryJson(inventory), 'json', 'application/json'),
          },
          {
            id: 'markdown',
            label: 'Markdown',
            description: 'Architecture documentation',
            icon: 'book',
            onSelect: () => download('markdown', exportInventoryMarkdown(inventory), 'md', 'text/markdown'),
          },
        ];

        const selectedLinks = selected ? linksFor(selected) : null;
        const impactHref = (targetId: string) => `${pagePath('change-impact')}?target=${encodeURIComponent(targetId)}`;

        const ImpactLink = ({ targetId, label = 'Analyze impact', compact = false }: { targetId: string; label?: string; compact?: boolean }) => {
          const href = impactHref(targetId);
          return (
            <a
              href={href}
              onClick={(event) => {
                if (!onNavigate) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                window.history.pushState(null, '', href);
                onNavigate('change-impact');
              }}
              className={compact ? 'text-xs font-semibold text-brand underline underline-offset-2' : 'btn-quiet px-2 py-1 text-xs'}
              aria-label={label}
            >
              {label}
            </a>
          );
        };

        const linkBadges = (object: ExplorerObject) => {
          const links = linksFor(object);
          return (
            <div className="mt-2 flex flex-wrap gap-1">
              {/* "No mapping found" is a discovery fact, not an error. */}
              <Badge tone={links.mappings.length > 0 ? 'success' : 'neutral'}>
                {links.mappings.length > 0 ? 'Has mapping' : 'No mapping found'}
              </Badge>
              {links.relationships.length > 0 ? <Badge tone="brand">Relationship available</Badge> : null}
            </div>
          );
        };

        const detailTabs: TabItem[] = selected && selectedLinks
          ? [
              {
                id: 'overview',
                label: 'Overview',
                content: (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg bg-surface-alt p-3">
                        <p className="label-xs">Data space</p>
                        <p className="mono mt-1 text-ink">{selected.dataSpace ?? '—'}</p>
                      </div>
                      <div className="rounded-lg bg-surface-alt p-3">
                        <p className="label-xs">Category</p>
                        <p className="mt-1 text-sm text-ink">{selected.category ?? '—'}</p>
                      </div>
                      <div className="rounded-lg bg-surface-alt p-3">
                        <p className="label-xs">{isDlo ? 'Source' : 'Object type'}</p>
                        <p className="mt-1 text-sm text-ink">{objectCategory(selected, kind)}</p>
                      </div>
                      <div className="rounded-lg bg-surface-alt p-3">
                        <p className="label-xs">Fields</p>
                        <p className="mt-1 text-sm font-semibold tabular-nums text-ink">{selected.fields.length}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">{linkBadges(selected)}</div>
                    <div className="rounded-lg border border-line bg-surface-alt p-4">
                      <p className="label-xs">Provenance</p>
                      <dl className="mt-2 grid gap-1.5 text-xs text-ink-soft">
                        <div className="flex justify-between gap-3"><dt>Endpoint</dt><dd className="mono truncate">{selected.provenance.sourceEndpoint}</dd></div>
                        <div className="flex justify-between gap-3"><dt>Confidence</dt><dd>{selected.provenance.confidence}</dd></div>
                        <div className="flex justify-between gap-3"><dt>Retrieved</dt><dd>{safeDateText(selected.provenance.retrievedAt)}</dd></div>
                      </dl>
                    </div>
                  </div>
                ),
              },
              {
                id: 'fields',
                label: `Fields (${selected.fields.length})`,
                content: (
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <DataTable
                      columns={[
                        ...fieldColumns,
                        {
                          key: 'impact',
                          header: <span className="sr-only">Impact</span>,
                          render: (field) => (
                            <ImpactLink
                              targetId={`field:${kind}:${selected.apiName}:${field.apiName}`}
                              label="Analyze impact"
                              compact
                            />
                          ),
                        },
                      ]}
                      rows={selected.fields}
                      getRowKey={(field) => field.apiName}
                      ariaLabel="Object fields"
                    />
                  </div>
                ),
              },
              {
                id: 'relationships',
                label: `Relationships (${selectedLinks.relationships.length})`,
                content: selectedLinks.relationships.length === 0 ? (
                  <p className="text-sm text-ink-soft">No relationships are recorded for this object.</p>
                ) : (
                  <ul className="space-y-2">
                    {selectedLinks.relationships.map((edge) => (
                      <li key={edge.id} className="rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="mono text-ink">{edge.source}</span>
                            <Icon name="arrowRight" size={14} className="text-ink-faint" />
                            <span className="mono text-ink">{edge.target}</span>
                          </div>
                          <ImpactLink targetId={`relationship:${edge.id}`} label="Analyze impact" compact />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                          <Badge tone={edge.certainty === 'confirmed' ? 'success' : 'warning'} dot>{edge.certainty}</Badge>
                          {edge.status ? <Badge tone="neutral" dot>{edge.status}</Badge> : null}
                          {edge.cardinality ? <span>{edge.cardinality}</span> : null}
                          {edge.label ? <span className="mono">{edge.label}</span> : null}
                          {edge.targetField && edge.targetField !== edge.label ? (
                            <span className="mono">→ {edge.targetField}</span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ),
              },
              {
                id: 'mappings',
                label: `Mappings (${selectedLinks.mappings.length})`,
                content: selectedLinks.mappings.length === 0 ? (
                  <p className="text-sm text-ink-soft">No mapping records reference this object.</p>
                ) : (
                  <ul className="space-y-2">
                    {selectedLinks.mappings.map((mapping) => (
                      <li key={mapping.apiName ?? `${mapping.sourceObject}-${mapping.targetObject}`} className="rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-sm">
                        <div className="flex flex-wrap items-center gap-2 font-medium text-ink">
                          <span className="mono">{mapping.sourceObject}</span>
                          <Icon name="arrowRight" size={14} className="text-ink-faint" />
                          <span className="mono">{mapping.targetObject}</span>
                        </div>
                        <p className="mt-1 text-xs text-ink-soft">{mapping.fieldMappings.length} field mappings</p>
                      </li>
                    ))}
                  </ul>
                ),
              },
              {
                id: 'streams',
                label: `Streams (${selectedLinks.streams.length})`,
                content: (
                  <div className="space-y-3">
                    {selectedLinks.streams.length === 0 ? (
                      <p className="text-sm text-ink-soft">No data streams record this object as their target.</p>
                    ) : (
                      <ul className="space-y-2">
                        {selectedLinks.streams.map((stream) => (
                          <li key={stream.apiName} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-sm">
                            <span className="font-medium text-ink">{stream.label ?? stream.apiName}</span>
                            <Badge tone="neutral">{stream.status ?? 'Status unknown'}</Badge>
                            {stream.refreshMetadata ? <span className="text-xs text-ink-soft">{stream.refreshMetadata}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-xs text-ink-soft">
                      Transform linkage is not exposed in the current metadata, so none is inferred here.
                    </p>
                  </div>
                ),
              },
              {
                id: 'raw',
                label: 'Raw Metadata',
                content: (
                  <pre className="overflow-x-auto rounded-lg border border-line bg-surface-alt p-3 text-xs text-ink-soft">
                    {JSON.stringify(selected, null, 2)}
                  </pre>
                ),
              },
            ]
          : [];

        const columns: DataTableColumn<ExplorerObject>[] = [
          {
            key: 'object',
            header: 'Object',
            render: (object) => (
              <div className="min-w-0">
                <p className="font-medium text-ink">{object.label ?? object.apiName}</p>
                <p className="mono mt-0.5 text-ink-faint">{object.apiName}</p>
                {linkBadges(object)}
              </div>
            ),
          },
          {
            key: 'space',
            header: 'Data space',
            render: (object) => object.dataSpace ? <span className="mono">{object.dataSpace}</span> : <span className="text-ink-faint">—</span>,
          },
          {
            key: 'category',
            header: 'Category / source',
            hideBelow: 'md',
            render: (object) => objectCategory(object, kind),
          },
          {
            key: 'fields',
            header: 'Fields',
            align: 'end',
            render: (object) => <span className="font-medium text-ink">{object.fields.length}</span>,
          },
          {
            key: 'action',
            header: <span className="sr-only">Actions</span>,
            render: (object) => (
              <Button variant="quiet" onClick={() => setSelected(object)} className="px-2 py-1 text-xs">
                Details
              </Button>
            ),
          },
        ];

        return (
          <>
            <ExportNotice mode={context?.mode ?? 'demo'} />
            <PageIntro
              title={title}
              description={description}
              actions={
                <>
                  <div className="w-full sm:w-64">
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      placeholder={isDlo ? 'Search DLOs or fields' : 'Search DMOs or fields'}
                      label={`Search ${title}`}
                    />
                  </div>
                  <label className="w-full sm:w-48">
                    <span className="sr-only">Filter by data space</span>
                    <select value={activeSpace} onChange={(event) => setSpace(event.target.value)} className="input h-9 py-1.5">
                      <option value="all">All data spaces</option>
                      {spaces.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{filtered.length} of {objects.length} objects</Badge>}
            />
            {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

            {capability && capability.status !== 'available' && capability.status !== 'not-started' ? (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-ink-soft" role="note">
                <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-warning" />
                <span className="min-w-0 break-words">
                  {resourceStatusMessage(capability)} Any objects below come from the inventory snapshot and are not invented by DCAT.
                </span>
              </div>
            ) : null}

            {filtered.length === 0 ? (
              <EmptyState
                title={
                  capability?.status === 'forbidden' ? `Access denied to ${isDlo ? 'DLOs' : 'DMOs'}`
                    : capability?.status === 'unsupported' ? `${isDlo ? 'DLOs' : 'DMOs'} are unavailable`
                      : capability?.status === 'error' ? `Could not load ${isDlo ? 'DLOs' : 'DMOs'}`
                        : capability?.status === 'partial' ? `Some ${isDlo ? 'DLOs' : 'DMOs'} may be missing`
                          : 'No objects found'
                }
                description={capability && capability.status !== 'available' && capability.status !== 'not-started'
                  ? resourceStatusMessage(capability)
                  : 'Try a different search term or clear the data space filter.'}
              />
            ) : (
              <>
                <div className="grid gap-2 md:hidden">
                  {filtered.map((object) => (
                    <button
                      key={object.apiName}
                      type="button"
                      onClick={() => setSelected(object)}
                      className="panel w-full p-4 text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">{object.label ?? object.apiName}</p>
                          <p className="mono mt-1 truncate text-ink-faint">{object.apiName}</p>
                        </div>
                        <Icon name="arrowRight" size={16} className="text-ink-faint" />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                        <Badge tone="neutral">{object.dataSpace ?? 'No space'}</Badge>
                        <span>{object.fields.length} fields</span>
                      </div>
                      {linkBadges(object)}
                    </button>
                  ))}
                </div>
                <div className="panel hidden overflow-hidden md:block">
                  <DataTable
                    columns={columns}
                    rows={filtered}
                    getRowKey={(object) => object.apiName}
                    ariaLabel={`${title} results`}
                  />
                </div>
              </>
            )}

            <DetailDrawer
              open={selected !== null}
              title={selected?.label ?? selected?.apiName ?? ''}
              subtitle={selected?.apiName}
              breadcrumbs={selected ? `${title} / ${selected.label ?? selected.apiName}` : undefined}
              headerActions={selected && selectedLinks ? (
                <>
                  <ImpactLink targetId={`${kind}:${selected.apiName}`} label="Analyze impact" />
                  <CopyButton value={selected.apiName} label="Copy API name" />
                  <CopyButton value={selected.provenance.sourceEndpoint} label="Copy endpoint" icon="route" />
                  <CopyButton
                    value={objectMarkdown(selected, kind, selectedLinks)}
                    label="Copy summary"
                    icon="book"
                  />
                </>
              ) : undefined}
              onClose={() => setSelected(null)}
            >
              {selected && detailTabs.length > 0 ? (
                <Tabs key={selected.apiName} items={detailTabs} label={`${title} detail sections`} />
              ) : null}
            </DetailDrawer>
          </>
        );
      }}
    </InventoryBoundary>
  );
}

interface FocusableExplorerProps {
  context: WorkspaceContext | null;
  focusObject?: FocusObject | null;
  onFocusHandled?: () => void;
  onNavigate?: (page: import('../navigation.ts').Page) => void;
}

export function DloExplorer({ context, focusObject, onFocusHandled, onNavigate }: FocusableExplorerProps) {
  return <ObjectExplorer context={context} kind="dlo" focusObject={focusObject} onFocusHandled={onFocusHandled} onNavigate={onNavigate} />;
}

export function DmoExplorer({ context, focusObject, onFocusHandled, onNavigate }: FocusableExplorerProps) {
  return <ObjectExplorer context={context} kind="dmo" focusObject={focusObject} onFocusHandled={onFocusHandled} onNavigate={onNavigate} />;
}
