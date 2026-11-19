import { useState } from 'react';
import {
  downloadTextFile,
  exportCsvTable,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import { countInDataSpace, countStreamsInDataSpace, filterByQuery, sameName } from '../lib/inventory.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Panel, SearchField, SectionHeading } from '../components/ui/index.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

const formatLabels = { csv: 'CSV', json: 'JSON', markdown: 'Markdown' } as const;

export function DataSpaces({ context }: { context: WorkspaceContext | null }) {
  const query = useInventory(context);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const spaces = filterByQuery(inventory.dataSpaces, search, (space) => [
          space.apiName,
          space.label ?? '',
          space.description ?? '',
        ]);

        const countsFor = (spaceApiName: string) => ({
          dlo: countInDataSpace(inventory.dlos, spaceApiName),
          dmo: countInDataSpace(inventory.dmos, spaceApiName),
          stream: countStreamsInDataSpace(inventory, spaceApiName),
        });

        const download = (format: keyof typeof formatLabels, contents: string, extension: string, mimeType: string) => {
          downloadTextFile(`dcat-data-spaces-${inventory.org.alias}.${extension}`, contents, mimeType);
          setMessage(`${formatLabels[format]} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          {
            id: 'csv',
            label: 'CSV',
            description: 'Visible spaces with object counts',
            icon: 'database',
            onSelect: () => download('csv', exportCsvTable(
              ['API name', 'Label', 'Default', 'Description', 'DLOs', 'DMOs', 'Streams'],
              spaces.map((space) => {
                const counts = countsFor(space.apiName);
                return [
                  space.apiName,
                  space.label,
                  space.isDefault ? 'Yes' : 'No',
                  space.description,
                  counts.dlo,
                  counts.dmo,
                  counts.stream,
                ];
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
              title="Data Spaces"
              description="Logical boundaries that group objects and define ownership in Data 360."
              actions={
                <>
                  <div className="w-full sm:w-64">
                    <SearchField value={search} onChange={setSearch} placeholder="Search spaces" label="Search data spaces" />
                  </div>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={<Badge tone="brand">{spaces.length} of {inventory.dataSpaces.length} spaces</Badge>}
            />
            {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

            {spaces.length === 0 ? (
              <Panel className="text-center text-sm text-ink-soft">No data spaces match that search.</Panel>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {spaces.map((space) => {
                  const counts = countsFor(space.apiName);
                  const linkedObjects = [
                    ...inventory.dlos.filter((object) => sameName(object.dataSpace, space.apiName)).map((object) => object.label ?? object.apiName),
                    ...inventory.dmos.filter((object) => sameName(object.dataSpace, space.apiName)).map((object) => object.label ?? object.apiName),
                  ];

                  return (
                    <Panel key={space.apiName} padded={false} className="overflow-hidden">
                      <div className="p-5">
                        <div className="flex items-start justify-between gap-3">
                          <Badge tone={space.isDefault ? 'brand' : 'neutral'} dot>
                            {space.isDefault ? 'Default space' : 'Data space'}
                          </Badge>
                          <Icon name="layers" size={18} className="text-brand" />
                        </div>
                        <h3 className="mt-4 text-base font-semibold tracking-tight text-ink">
                          {space.label ?? space.apiName}
                        </h3>
                        <p className="mono mt-1 text-ink-soft">{space.apiName}</p>
                        <p className="mt-3 min-h-10 text-sm text-ink-soft">
                          {space.description ?? 'No description was provided by the source metadata.'}
                        </p>
                      </div>
                      <div className="grid grid-cols-3 divide-x divide-line border-y border-line bg-surface-alt">
                        {[
                          { label: 'DLOs', value: counts.dlo },
                          { label: 'DMOs', value: counts.dmo },
                          { label: 'Streams', value: counts.stream },
                        ].map((stat) => (
                          <div key={stat.label} className="px-4 py-3 text-center">
                            <p className="text-lg font-semibold tabular-nums text-ink">{stat.value}</p>
                            <p className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">{stat.label}</p>
                          </div>
                        ))}
                      </div>
                      <div className="p-5">
                        <SectionHeading title="Linked objects" />
                        {linkedObjects.length === 0 ? (
                          <p className="text-sm text-ink-soft">No objects are assigned to this space.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {linkedObjects.map((object) => (
                              <span key={object} className="rounded-md border border-line bg-surface-alt px-2 py-1 text-xs text-ink-soft">
                                {object}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </Panel>
                  );
                })}
              </div>
            )}
          </>
        );
      }}
    </InventoryBoundary>
  );
}
