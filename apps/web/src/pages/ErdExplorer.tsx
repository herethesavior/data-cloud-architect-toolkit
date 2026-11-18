import { useState } from 'react';
import {
  buildErdLayout,
  downloadTextFile,
  exportErdSvg,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import type { ErdCertaintyFilter } from '@dcat/exporters';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Panel, SectionHeading } from '../components/ui/index.ts';
import { getThemePalette } from '../lib/theme.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

const filters: { value: ErdCertaintyFilter; label: string }[] = [
  { value: 'all', label: 'All edges' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'inferred', label: 'Inferred' },
];

const formatLabels = { svg: 'SVG', json: 'JSON', markdown: 'Markdown' } as const;

function edgeTone(certainty: 'confirmed' | 'inferred' | 'unknown') {
  return certainty === 'confirmed' ? 'success' : certainty === 'inferred' ? 'warning' : 'neutral';
}

export function ErdExplorer({ context }: { context: WorkspaceContext | null }) {
  const query = useInventory(context);
  const [filter, setFilter] = useState<ErdCertaintyFilter>('all');
  const [message, setMessage] = useState('');

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => {
        const layout = buildErdLayout(inventory);
        const edges = layout.edges.filter((edge) =>
          filter === 'all'
            || (filter === 'confirmed' && edge.certainty === 'confirmed')
            || (filter === 'inferred' && edge.certainty === 'inferred'),
        );

        const download = (format: keyof typeof formatLabels, contents: string, extension: string, mimeType: string) => {
          downloadTextFile(`dcat-erd-${inventory.org.alias}.${extension}`, contents, mimeType);
          setMessage(`${formatLabels[format]} export downloaded.`);
        };

        const exportItems: ExportMenuItem[] = [
          {
            id: 'svg',
            label: 'SVG',
            description: 'Visible edges in the current theme',
            icon: 'graph',
            onSelect: () => download('svg', exportErdSvg(inventory, getThemePalette(), filter), 'svg', 'image/svg+xml'),
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
              title="ERD Explorer"
              description="A compact entity relationship view. Solid edges are source-confirmed; dashed edges are inferred from field names."
              actions={
                <>
                  <div className="inline-flex rounded-lg border border-line bg-surface p-1" role="group" aria-label="Filter relationships by certainty">
                    {filters.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setFilter(option.value)}
                        aria-pressed={filter === option.value}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          filter === option.value ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-surface-alt'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {freshness}
                  <ExportMenu items={exportItems} />
                </>
              }
              meta={
                <>
                  <Badge tone="brand">{layout.nodes.length} objects</Badge>
                  <Badge tone="neutral">{edges.length} visible edges</Badge>
                </>
              }
            />
            {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

            <Panel padded={false} className="overflow-hidden">
              <div className="overflow-x-auto p-4 sm:p-5">
                <svg
                  aria-labelledby="erd-title erd-description"
                  className="h-auto w-full min-w-[760px]"
                  role="img"
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                >
                  <title id="erd-title">Data 360 entity relationships for {inventory.org.alias}</title>
                  <desc id="erd-description">
                    {layout.nodes.length} data model objects connected by {edges.length} relationships. Confirmed relationships are solid; inferred relationships are dashed.
                  </desc>
                  <defs>
                    <marker id="erd-arrow-confirmed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-brand)" />
                    </marker>
                    <marker id="erd-arrow-inferred" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-warning)" />
                    </marker>
                  </defs>

                  {edges.map((edge) => {
                    const confirmed = edge.certainty === 'confirmed';
                    return (
                      <g key={edge.id}>
                        <path
                          d={edge.path}
                          fill="none"
                          markerEnd={`url(#${confirmed ? 'erd-arrow-confirmed' : 'erd-arrow-inferred'})`}
                          stroke={confirmed ? 'var(--color-brand)' : 'var(--color-warning)'}
                          strokeDasharray={confirmed ? undefined : '6 5'}
                          strokeWidth={2}
                        />
                        <text
                          fill="var(--color-ink-soft)"
                          fontFamily="inherit"
                          fontSize={11}
                          textAnchor="middle"
                          x={edge.labelX}
                          y={edge.labelY}
                        >
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}

                  {layout.nodes.map((node) => (
                    <g key={node.id}>
                      <rect
                        fill="var(--color-surface)"
                        height={node.height}
                        rx={10}
                        stroke="var(--color-line)"
                        width={node.width}
                        x={node.x}
                        y={node.y}
                      />
                      <rect
                        fill="var(--color-brand)"
                        height={node.height}
                        rx={2}
                        width={4}
                        x={node.x}
                        y={node.y}
                      />
                      <text fill="var(--color-ink)" fontFamily="inherit" fontSize={13} fontWeight={600} x={node.x + 16} y={node.y + 28}>
                        {node.label}
                      </text>
                      <text fill="var(--color-ink-faint)" fontFamily="inherit" fontSize={10} x={node.x + 16} y={node.y + 46}>
                        {node.apiName}
                      </text>
                      <text fill="var(--color-ink-soft)" fontFamily="inherit" fontSize={10} x={node.x + 16} y={node.y + 68}>
                        {node.fieldCount} fields
                      </text>
                    </g>
                  ))}

                  <line
                    stroke="var(--color-brand)"
                    strokeWidth={2}
                    x1={60}
                    x2={92}
                    y1={layout.height - 28}
                    y2={layout.height - 28}
                  />
                  <text fill="var(--color-ink-soft)" fontSize={11} x={100} y={layout.height - 24}>Confirmed</text>
                  <line
                    stroke="var(--color-warning)"
                    strokeDasharray="6 5"
                    strokeWidth={2}
                    x1={200}
                    x2={232}
                    y1={layout.height - 28}
                    y2={layout.height - 28}
                  />
                  <text fill="var(--color-ink-soft)" fontSize={11} x={240} y={layout.height - 24}>Inferred</text>
                </svg>
              </div>
            </Panel>

            <Panel>
              <SectionHeading title="Relationship detail" description="Certainty is shown on every edge so inferred links are never mistaken for source facts." />
              <div className="grid gap-2 md:grid-cols-2">
                {edges.map((edge) => (
                  <div key={edge.id} className="rounded-lg border border-line bg-surface-alt px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={edgeTone(edge.certainty)} dot>{edge.certainty}</Badge>
                      {edge.cardinality ? <span className="text-xs text-ink-soft">{edge.cardinality}</span> : null}
                    </div>
                    <p className="mono mt-2 text-xs text-ink">
                      {edge.source} <span className="text-ink-faint">→</span> {edge.target}
                    </p>
                    <p className="mt-1 text-xs text-ink-soft">Join field: <span className="mono">{edge.label}</span></p>
                  </div>
                ))}
                {edges.length === 0 ? (
                  <p className="text-sm text-ink-soft">No relationships match this filter.</p>
                ) : null}
              </div>
            </Panel>
          </>
        );
      }}
    </InventoryBoundary>
  );
}
