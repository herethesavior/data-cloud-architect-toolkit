import { useState } from 'react';
import type { MouseEvent } from 'react';
import {
  downloadTextFile,
  exportInventoryCsv,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import { isFamilyLoading, shownCountLabel } from '../lib/inventoryDisplay.ts';
import { buildDictionaryRows, filterByQuery } from '../lib/inventory.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, DataTable, Panel, SearchField } from '../components/ui/index.ts';
import type { DataTableColumn } from '../components/ui/index.ts';
import { useInventory } from '../lib/useInventory.ts';
import { pageHref, pagePath } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import type { DictionaryRow } from '../lib/inventory.ts';
import type { InventorySnapshot } from '@dcat/core';

function impactTargetId(row: DictionaryRow): string {
  return `field:${row.objectType.toLowerCase()}:${row.objectApiName}:${row.field.apiName}`;
}

function impactHref(row: DictionaryRow): string {
  return `${pagePath('change-impact')}?target=${encodeURIComponent(impactTargetId(row))}`;
}

function makeColumns(onNavigate?: (page: Page) => void): DataTableColumn<DictionaryRow>[] {
  return [
  {
    key: 'object',
    header: 'Object',
    render: (row) => (
      <div className="min-w-0">
        <p className="font-medium text-ink">{row.objectLabel}</p>
        <p className="mono mt-0.5 text-ink-faint">{row.objectApiName}</p>
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => <Badge tone={row.objectType === 'DMO' ? 'brand' : 'neutral'}>{row.objectType}</Badge>,
  },
  { key: 'field', header: 'Field', render: (row) => <span className="mono text-ink">{row.field.apiName}</span> },
  { key: 'label', header: 'Label', render: (row) => row.field.label ?? '—', hideBelow: 'md' },
  { key: 'dataType', header: 'Data type', render: (row) => <span className="mono">{row.field.dataType ?? '—'}</span> },
  {
    key: 'key',
    header: 'Key',
    render: (row) => (row.field.isPrimaryKey ? <Badge tone="success">Primary</Badge> : <span className="text-ink-faint">—</span>),
  },
  { key: 'space', header: 'Data space', render: (row) => <span className="mono">{row.dataSpace}</span>, hideBelow: 'lg' },
  {
    key: 'impact',
    header: <span className="sr-only">Impact</span>,
    render: (row) => {
      const href = impactHref(row);
      const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!onNavigate) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        window.history.pushState(null, '', href);
        onNavigate('change-impact');
      };
      return (
        <a href={href} onClick={onClick} className="text-xs font-semibold text-brand underline underline-offset-2">
          Analyze impact
        </a>
      );
    },
  },
];
}

type ExportFormat = 'json' | 'csv' | 'markdown';

const formatLabels: Record<ExportFormat, string> = { csv: 'CSV', markdown: 'Markdown', json: 'JSON' };

function exportText(inventory: InventorySnapshot, format: ExportFormat): { contents: string; mimeType: string; extension: string } {
  if (format === 'csv') return { contents: exportInventoryCsv(inventory), mimeType: 'text/csv', extension: 'csv' };
  if (format === 'markdown') return { contents: exportInventoryMarkdown(inventory), mimeType: 'text/markdown', extension: 'md' };
  return { contents: exportInventoryJson(inventory), mimeType: 'application/json', extension: 'json' };
}

export function DataDictionary({ context, onNavigate }: { context: WorkspaceContext | null; onNavigate?: (page: Page) => void }) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | 'DLO' | 'DMO'>('all');
  const [message, setMessage] = useState('');
  const columns = makeColumns(onNavigate);

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const allRows = buildDictionaryRows(inventory);
        const rows = filterByQuery(allRows, search, (row) => [
          row.objectType,
          row.objectApiName,
          row.objectLabel,
          row.dataSpace,
          row.field.apiName,
          row.field.label ?? '',
          row.field.dataType ?? '',
          row.field.description ?? '',
        ]).filter((row) => type === 'all' || row.objectType === type);

        const download = (format: ExportFormat) => {
          const output = exportText(inventory, format);
          downloadTextFile(`dcat-inventory-${inventory.org.alias}.${output.extension}`, output.contents, output.mimeType);
          setMessage(`${formatLabels[format]} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          { id: 'csv', label: 'CSV', description: 'Full field reference', icon: 'database', onSelect: () => download('csv') },
          { id: 'markdown', label: 'Markdown', description: 'Architecture documentation', icon: 'book', onSelect: () => download('markdown') },
          { id: 'json', label: 'JSON', description: 'Complete machine-readable inventory', icon: 'layers', onSelect: () => download('json') },
        ];

        return (
          <>
            <ExportNotice mode={context?.mode ?? 'demo'} />
            <PageIntro
              title="Data Dictionary"
              description="A searchable field reference across DLOs and DMOs, with local exports for architecture reviews."
              actions={
                <>
                  <div className="w-full sm:w-64">
                    <SearchField
                      value={search}
                      onChange={setSearch}
                      placeholder="Search fields or objects"
                      label="Search data dictionary"
                    />
                  </div>
                  <label className="w-full sm:w-36">
                    <span className="sr-only">Filter by object type</span>
                    <select value={type} onChange={(event) => setType(event.target.value as 'all' | 'DLO' | 'DMO')} className="input h-9 py-1.5">
                      <option value="all">All objects</option>
                      <option value="DLO">DLO fields</option>
                      <option value="DMO">DMO fields</option>
                    </select>
                  </label>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{inventory.progress
                ? shownCountLabel(
                  rows.length,
                  allRows.length,
                  null,
                  isFamilyLoading(inventory, 'dlos') || isFamilyLoading(inventory, 'dmos'),
                  'fields',
                )
                : `${rows.length} of ${allRows.length} fields`}</Badge>}
            />

            <Panel className="mb-5 flex flex-wrap items-center gap-3 border-warning/20 bg-warning-soft">
              <Icon name="warning" size={18} className="text-warning" />
              <p className="min-w-0 flex-1 text-sm text-warning">
                <strong>Review before sharing.</strong> Exported metadata can reveal internal architecture and naming conventions. It contains no customer records.
              </p>
            </Panel>
            {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

            <Panel padded={false} className="overflow-hidden">
              <DataTable
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.key}
                ariaLabel="Data dictionary fields"
                pageSize={100}
                emptyMessage={isFamilyLoading(inventory, 'dlos') || isFamilyLoading(inventory, 'dmos')
                  ? 'Fields are still loading; this result is not final yet.'
                  : 'No fields match the current filters.'}
              />
            </Panel>
          </>
        );
      }}
    </InventoryBoundary>
  );
}
