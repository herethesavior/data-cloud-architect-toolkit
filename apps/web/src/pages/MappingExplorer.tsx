import { useState } from 'react';
import type { DataMapping } from '@dcat/core';
import {
  downloadTextFile,
  exportCsvTable,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import { filterByQuery } from '../lib/inventory.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, DataTable, Panel, SearchField } from '../components/ui/index.ts';
import type { DataTableColumn } from '../components/ui/index.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

type FieldMapping = DataMapping['fieldMappings'][number];

const formatLabels = { csv: 'CSV', json: 'JSON', markdown: 'Markdown' } as const;

const fieldColumns: DataTableColumn<FieldMapping>[] = [
  { key: 'source', header: 'Source field', render: (field) => <span className="mono text-ink">{field.sourceField}</span> },
  {
    key: 'target',
    header: 'Target field',
    render: (field) => (
      <div className="flex items-center gap-2">
        <Icon name="arrowRight" size={13} className="text-ink-faint" />
        <span className="mono text-ink">{field.targetField}</span>
      </div>
    ),
  },
  {
    key: 'transform',
    header: 'Transformation',
    render: (field) => (field.transformation ? <Badge tone="brand">{field.transformation}</Badge> : <span className="text-ink-faint">—</span>),
  },
];

export function MappingExplorer({ context }: { context: WorkspaceContext | null }) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const mappings = filterByQuery(inventory.mappings, search, (mapping) => [
          mapping.apiName ?? '',
          mapping.sourceObject,
          mapping.targetObject,
          ...mapping.fieldMappings.flatMap((field) => [field.sourceField, field.targetField, field.transformation ?? '']),
        ]);

        const download = (format: keyof typeof formatLabels, contents: string, extension: string, mimeType: string) => {
          downloadTextFile(`dcat-mappings-${inventory.org.alias}.${extension}`, contents, mimeType);
          setMessage(`${formatLabels[format]} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          {
            id: 'csv',
            label: 'CSV',
            description: 'Visible mappings and field mappings',
            icon: 'route',
            onSelect: () => download('csv', exportCsvTable(
              ['Mapping', 'Source object', 'Target object', 'Source field', 'Target field', 'Transformation'],
              mappings.flatMap((mapping) => {
                const fields = mapping.fieldMappings.length > 0 ? mapping.fieldMappings : [null];
                return fields.map((field) => [
                  mapping.apiName,
                  mapping.sourceObject,
                  mapping.targetObject,
                  field?.sourceField,
                  field?.targetField,
                  field?.transformation,
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

        return (
          <>
            <ExportNotice mode={context?.mode ?? 'demo'} />
            <PageIntro
              title="Mapping Explorer"
              description="Follow lineage from Data Lake Objects to the Data Model Objects they populate."
              actions={
                <>
                  <div className="w-full sm:w-72">
                    <SearchField value={search} onChange={setSearch} placeholder="Search mappings or fields" label="Search mappings" />
                  </div>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{mappings.length} of {inventory.mappings.length} mappings</Badge>}
            />
            {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

            {mappings.length === 0 ? (
              <Panel role="status" className="text-center text-sm text-ink-soft">No mappings match that search.</Panel>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {mappings.map((mapping, index) => (
                  <Panel key={mapping.apiName ?? `${mapping.sourceObject}-${mapping.targetObject}-${index}`} padded={false}>
                    <div className="p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone="neutral">Mapping</Badge>
                        <span className="mono truncate text-ink-faint">{mapping.apiName ?? 'unnamed mapping'}</span>
                      </div>

                      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                        <div className="rounded-lg bg-surface-alt px-3 py-2.5">
                          <p className="label-xs">Source</p>
                          <p className="mono mt-1 truncate text-ink" title={mapping.sourceObject}>{mapping.sourceObject}</p>
                        </div>
                        <Icon name="arrowRight" size={18} className="mx-auto rotate-90 text-brand sm:rotate-0" />
                        <div className="rounded-lg bg-surface-alt px-3 py-2.5">
                          <p className="label-xs">Target</p>
                          <p className="mono mt-1 truncate text-ink" title={mapping.targetObject}>{mapping.targetObject}</p>
                        </div>
                      </div>

                      <details className="group mt-4">
                        <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-surface-alt [&::-webkit-details-marker]:hidden">
                          <span>{mapping.fieldMappings.length} field mappings</span>
                          <Icon name="chevronDown" size={16} className="text-ink-soft transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
                          <DataTable
                            columns={fieldColumns}
                            rows={mapping.fieldMappings}
                            getRowKey={(field) => `${field.sourceField}-${field.targetField}`}
                            ariaLabel="Field mappings"
                          />
                        </div>
                      </details>
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </>
        );
      }}
    </InventoryBoundary>
  );
}
