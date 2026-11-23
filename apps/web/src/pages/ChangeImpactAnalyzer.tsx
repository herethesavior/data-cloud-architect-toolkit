import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  analyzeImpact,
  buildImpactTargets,
  IMPACT_CONFIDENCE_LABELS,
  IMPACT_GROUP_LABELS,
  impactSnapshotComplete,
  resolveImpactTarget,
} from '@dcat/exporters';
import type { ImpactAnalysis, ImpactDirection, ImpactDepth, ImpactItem, ImpactTarget } from '@dcat/exporters';
import type { InventorySnapshot } from '@dcat/core';
import { navigateFromLink } from '../components/AppShell.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Panel, SearchField, SectionHeading } from '../components/ui/index.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import { PAGE_TITLES, pageHref, pagePath } from '../navigation.ts';
import type { Page } from '../navigation.ts';

interface ImpactParams {
  target: string | null;
  direction: ImpactDirection;
  depth: ImpactDepth;
}

function readImpactParams(): ImpactParams {
  const params = new URLSearchParams(window.location.search);
  return {
    target: params.get('target'),
    direction: readDirection(params.get('direction')),
    depth: readDepth(params.get('depth')),
  };
}

function writeImpactParams(patch: Partial<ImpactParams>, mode: 'push' | 'replace' = 'replace') {
  const url = new URL(window.location.href);
  url.pathname = pagePath('change-impact');
  url.hash = '';
  if (patch.target !== undefined) {
    if (patch.target) url.searchParams.set('target', patch.target);
    else url.searchParams.delete('target');
  }
  if (patch.direction !== undefined) url.searchParams.set('direction', patch.direction);
  if (patch.depth !== undefined) url.searchParams.set('depth', patch.depth);
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next === current) return;
  if (mode === 'replace') window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
}

interface ChangeImpactAnalyzerProps {
  context: WorkspaceContext | null;
  onNavigate: (page: Page) => void;
}

const directionOptions: { value: ImpactDirection; label: string }[] = [
  { value: 'downstream', label: 'Downstream' },
  { value: 'upstream', label: 'Upstream' },
  { value: 'both', label: 'Both directions' },
];

const depthOptions: { value: ImpactDepth; label: string }[] = [
  { value: 'direct', label: '1 hop' },
  { value: 'all', label: 'All paths' },
];

function confidenceTone(confidence: ImpactItem['confidence']): BadgeTone {
  if (confidence === 'source') return 'success';
  if (confidence === 'derived') return 'warning';
  return 'danger';
}

function certaintyLabel(item: ImpactItem): string | null {
  if (item.certainty) return item.certainty === 'confirmed' ? 'Confirmed' : 'Inferred';
  if (item.confidence === 'derived') return 'DCAT-derived';
  if (item.confidence === 'missing') return 'Missing';
  if (item.confidence === 'source') return 'Source-named';
  return null;
}

function targetKindLabel(target: ImpactTarget): string {
  if (target.kind === 'field') return 'Field';
  if (target.kind === 'relationship') return 'Relationship';
  return target.objectKind === 'dmo' ? 'DMO' : 'DLO';
}

function targetUrl(targetId: string, direction: ImpactDirection, depth: ImpactDepth): string {
  const params = new URLSearchParams();
  params.set('target', targetId);
  params.set('direction', direction);
  params.set('depth', depth);
  return `${pagePath('change-impact')}?${params.toString()}`;
}

function readDirection(value: string | null): ImpactDirection {
  return value === 'upstream' || value === 'both' ? value : 'downstream';
}

function readDepth(value: string | null): ImpactDepth {
  return value === 'all' ? 'all' : 'direct';
}

function groupItems(items: ImpactItem[]): { group: ImpactItem['group']; label: string; items: ImpactItem[] }[] {
  const order: ImpactItem['group'][] = ['mappings', 'transforms', 'streams', 'objects', 'relationships', 'gaps'];
  return order
    .map((group) => ({ group, label: IMPACT_GROUP_LABELS[group], items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}

function ResultCard({
  item,
  onNavigate,
}: {
  item: ImpactItem;
  onNavigate: (page: Page) => void;
}) {
  const certainty = certaintyLabel(item);
  const explorerPage = item.explorer === 'dictionary' ? 'dictionary' : (item.explorer as Page);
  return (
    <li className="rounded-lg border border-line bg-surface-alt p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{item.label}</p>
          <p className="mt-0.5 text-xs text-ink-soft">{item.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={confidenceTone(item.confidence)} dot>{IMPACT_CONFIDENCE_LABELS[item.confidence]}</Badge>
          {certainty && certainty !== IMPACT_CONFIDENCE_LABELS[item.confidence] ? (
            <Badge tone="neutral">{certainty}</Badge>
          ) : null}
          <Badge tone="neutral">{item.direction === 'downstream' ? 'Downstream' : 'Upstream'}</Badge>
          <Badge tone="neutral">{item.hop === 1 ? 'Direct' : `${item.hop} hops`}</Badge>
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-soft">{item.why}</p>
      {item.steps.length > 0 ? (
        <ol className="mt-2 space-y-1 border-l-2 border-line pl-3">
          {item.steps.map((step) => (
            <li key={step.id} className="text-xs text-ink-soft">
              <span className="font-medium text-ink">{step.label}</span>
              {step.objectLevelOnly ? <span> · Object-level link; field continuity not recorded past this point.</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <a
          href={pageHref(explorerPage)}
          onClick={(event) => navigateFromLink(event, explorerPage, onNavigate)}
          className="text-xs font-semibold text-brand underline underline-offset-2"
        >
          Open in {PAGE_TITLES[explorerPage]}
        </a>
        <a
          href={pageHref('lineage')}
          onClick={(event) => navigateFromLink(event, 'lineage', onNavigate)}
          className="text-xs font-semibold text-brand underline underline-offset-2"
        >
          Open in Data Lineage Explorer
        </a>
      </div>
    </li>
  );
}

function AnalyzerView({
  inventory,
  freshness,
  onNavigate,
}: {
  inventory: InventorySnapshot;
  freshness: ReactNode;
  onNavigate: (page: Page) => void;
}) {
  const [params, setParams] = useState<ImpactParams>(readImpactParams);
  const [search, setSearch] = useState('');
  const targets = useMemo(() => buildImpactTargets(inventory), [inventory]);
  const { target: selectedId, direction, depth } = params;
  const selected = useMemo(() => resolveImpactTarget(inventory, selectedId), [inventory, selectedId]);

  useEffect(() => {
    const sync = () => setParams(readImpactParams());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const filteredTargets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return targets.slice(0, 60);
    return targets.filter((target) =>
      [target.label, target.anchorLabel, target.subtitle, target.apiName].some((value) => value.toLowerCase().includes(q)),
    ).slice(0, 60);
  }, [targets, search]);

  useEffect(() => {
    if (!selectedId || selected) return;
    // Drop a stale target id so the page does not claim impact for an object that is no longer in the snapshot.
    writeImpactParams({ target: null });
    setParams(readImpactParams());
  }, [selectedId, selected]);

  const analysis: ImpactAnalysis | null = useMemo(() => {
    if (!selected) return null;
    return analyzeImpact(inventory, selected, { direction, depth });
  }, [inventory, selected, direction, depth]);

  const updateParams = (patch: Partial<ImpactParams>) => {
    writeImpactParams(patch);
    setParams((current) => ({ ...current, ...patch }));
  };

  const groups = analysis ? groupItems(analysis.items) : [];
  const complete = impactSnapshotComplete(inventory);

  return (
    <>
      <PageIntro
        title="Change Impact Analyzer"
        description="Select a DLO, DMO, field, or relationship and see its upstream and downstream dependencies. Results are grounded in the current snapshot: direct and all-path counts are separate, inferred links stay labelled, and missing references appear as gaps."
        actions={freshness}
        meta={selected && analysis ? (
          <>
            <Badge tone="brand">{analysis.totalCount} reviewed</Badge>
            <Badge tone="neutral">{analysis.directCount} direct</Badge>
            <Badge tone={analysis.exactFieldMatchCount > 0 ? 'success' : 'neutral'}>
              {analysis.exactFieldMatchCount} exact field link{analysis.exactFieldMatchCount === 1 ? '' : 's'}
            </Badge>
          </>
        ) : <Badge tone="neutral">{targets.length} selectable targets</Badge>}
      />

      {!complete ? (
        <Panel className="mb-4 border-warning/25 bg-warning-soft">
          <p className="text-sm text-ink-soft">
            <strong className="text-ink">Partial snapshot.</strong> One or more metadata families this analysis depends on are unavailable or incomplete. Review the gaps and discovery status before treating the result as exhaustive.
          </p>
        </Panel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <Panel className="space-y-4">
          <SectionHeading title="Choose a target" description="Pick an object, field, or relationship from the current snapshot." />
          <SearchField
            value={search}
            onChange={setSearch}
            label="Search impact targets"
            placeholder="Search objects, fields, relationships"
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Impact direction">
            {directionOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn-quiet px-2.5 text-xs ${direction === option.value ? 'text-brand' : ''}`}
                aria-pressed={direction === option.value}
                onClick={() => updateParams({ direction: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Impact depth">
            {depthOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn-quiet px-2.5 text-xs ${depth === option.value ? 'text-brand' : ''}`}
                aria-pressed={depth === option.value}
                onClick={() => updateParams({ depth: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1" aria-label="Impact targets">
            {filteredTargets.length === 0 ? (
              <p className="text-sm text-ink-soft">No targets match “{search}”.</p>
            ) : filteredTargets.map((target) => (
              <button
                key={target.id}
                type="button"
                onClick={() => updateParams({ target: target.id })}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selected?.id === target.id ? 'border-brand bg-brand-soft' : 'border-line bg-surface-alt hover:border-brand'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{target.label}</span>
                  <Badge tone="neutral">{targetKindLabel(target)}</Badge>
                </div>
                <p className="mono mt-1 truncate text-xs text-ink-faint">{target.anchorLabel}</p>
                <p className="mt-1 text-xs text-ink-soft">{target.subtitle}</p>
              </button>
            ))}
          </div>
        </Panel>

        <div className="space-y-4">
          {!selected ? (
            <Panel>
              <SectionHeading title="Review impact before you change it" description="Choose a target to see what DCAT can identify from the current snapshot." />
              <p className="text-sm text-ink-soft">
                Ask: <span className="font-medium text-ink">“What could be affected if I change this field?”</span> DCAT could identify related mappings, transforms, and downstream objects that need review. It will not infer field mappings from names or types, and it will keep gaps visible.
              </p>
            </Panel>
          ) : analysis ? (
            <>
              <Panel>
                <SectionHeading title={selected.label} description={selected.anchorLabel} />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">{targetKindLabel(selected)}</Badge>
                  <Badge tone="neutral">{directionOptions.find((option) => option.value === direction)?.label}</Badge>
                  <Badge tone="neutral">{depth === 'direct' ? '1 hop' : 'All paths'}</Badge>
                  {selected.dataSpace ? <Badge tone="neutral">{selected.dataSpace}</Badge> : null}
                </div>
                <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-line bg-surface-alt px-3 py-2">
                    <dt className="text-xs text-ink-soft">Direct dependencies</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{analysis.directCount}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-alt px-3 py-2">
                    <dt className="text-xs text-ink-soft">All reviewed paths</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{analysis.totalCount}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-alt px-3 py-2">
                    <dt className="text-xs text-ink-soft">Downstream / Upstream</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{analysis.downstreamCount} / {analysis.upstreamCount}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-alt px-3 py-2">
                    <dt className="text-xs text-ink-soft">Exact field links</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{analysis.exactFieldMatchCount}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-ink-soft">
                  Shareable link: <span className="mono break-all">{targetUrl(selected.id, direction, depth)}</span>
                </p>
              </Panel>

              {groups.length === 0 ? (
                <Panel>
                  <p className="text-sm text-ink-soft">No grounded dependencies were found in the current snapshot for this selection and scope. This can mean the object is isolated, the direction/depth excludes relevant paths, or the snapshot does not record the linkage.</p>
                </Panel>
              ) : groups.map((group) => (
                <Panel key={group.group}>
                  <SectionHeading title={group.label} description={`${group.items.length} item${group.items.length === 1 ? '' : 's'} to review`} />
                  <ul className="space-y-3">
                    {group.items.map((item) => (
                      <ResultCard key={`${item.group}:${item.id}:${item.direction}`} item={item} onNavigate={onNavigate} />
                    ))}
                  </ul>
                </Panel>
              ))}
            </>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-ink-faint">
        Impact is computed from the current inventory snapshot in this browser. It shows metadata DCAT can identify; it does not scan code, run-time behavior, or unrecorded field logic.
      </p>
    </>
  );
}

export function ChangeImpactAnalyzer({ context, onNavigate }: ChangeImpactAnalyzerProps) {
  const query = useInventory(context);
  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => (
        <AnalyzerView inventory={inventory} freshness={freshness} onNavigate={onNavigate} />
      )}
    </InventoryBoundary>
  );
}
