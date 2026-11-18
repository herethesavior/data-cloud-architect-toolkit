import { useState } from 'react';
import type { RetrievalStatus } from '@dcat/core';
import { downloadTextFile, exportCsvTable, exportInventoryJson, exportInventoryMarkdown } from '@dcat/exporters';
import type { Page } from '../navigation.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { NoOrgState } from '../components/NoOrgState.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, Panel, SectionHeading } from '../components/ui/index.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import { discoverySummary } from '../lib/inventory.ts';
import { useInventoryActions } from '../lib/inventoryActions.tsx';
import {
  actionableWarnings,
  data360NotEnabled,
  discoveryStages,
  resourceStatusMessage,
  retryableFamilyCount,
  statusLabel,
} from '../lib/resourceStatus.ts';
import type { ResourceStageState } from '../lib/resourceStatus.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext, WorkspaceMode } from '../lib/workspace.ts';

interface DashboardProps {
  context: WorkspaceContext | null;
  mode: WorkspaceMode;
  onNavigate: (page: Page) => void;
}

function statusTone(status: RetrievalStatus): BadgeTone {
  if (status === 'available') return 'success';
  if (status === 'partial' || status === 'unsupported') return 'warning';
  if (status === 'error' || status === 'forbidden') return 'danger';
  return 'neutral';
}

function stageTone(state: ResourceStageState): BadgeTone {
  if (state === 'complete') return 'success';
  if (state === 'loading') return 'brand';
  if (state === 'partial') return 'warning';
  if (state === 'blocked') return 'danger';
  return 'neutral';
}

function humanize(value: string): string {
  const acronyms: Record<string, string> = { dlos: 'DLOs', dmos: 'DMOs' };
  if (acronyms[value]) return acronyms[value];
  return value.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function Dashboard({ context, mode, onNavigate }: DashboardProps) {
  const query = useInventory(context);
  const inventoryActions = useInventoryActions();
  const [exportMessage, setExportMessage] = useState('');

  if (!context) {
    return (
      <>
        <PageIntro
          title="Dashboard"
          description="A single view of your discovered Data 360 inventory."
        />
        <NoOrgState />
      </>
    );
  }

  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory) => {
        const summary = discoverySummary(inventory);
        const stages = discoveryStages(inventory);
        const retryableCount = retryableFamilyCount(inventory);
        const data360Unavailable = data360NotEnabled(inventory);
        const attentionWarnings = actionableWarnings(inventory);

        const download = (format: 'csv' | 'json' | 'markdown') => {
          if (format === 'csv') {
            const contents = exportCsvTable(
              ['Resource family', 'Status', 'Items', 'Endpoint', 'Detail'],
              inventory.capabilities.map((capability) => [
                capability.family,
                capability.status,
                capability.itemCount,
                capability.endpoint,
                resourceStatusMessage(capability),
              ]),
            );
            downloadTextFile(`dcat-discovery-${inventory.org.alias}.csv`, contents, 'text/csv');
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
          { id: 'csv', label: 'CSV', description: 'Discovery summary', icon: 'download', onSelect: () => download('csv') },
          { id: 'json', label: 'JSON', description: 'Full inventory', icon: 'download', onSelect: () => download('json') },
          { id: 'markdown', label: 'Markdown', description: 'Architecture summary', icon: 'book', onSelect: () => download('markdown') },
        ];

        const metrics: { label: string; value: number; page: Page; icon: IconName }[] = [
          { label: 'Data Spaces', value: inventory.dataSpaces.length, page: 'data-spaces', icon: 'layers' },
          { label: 'DLOs', value: inventory.dlos.length, page: 'dlos', icon: 'database' },
          { label: 'DMOs', value: inventory.dmos.length, page: 'dmos', icon: 'cube' },
          { label: 'Mappings', value: inventory.mappings.length, page: 'mappings', icon: 'route' },
          { label: 'Transforms', value: inventory.dataTransforms.length, page: 'data-transforms', icon: 'sparkles' },
        ];
        const flowSteps: { label: string; value: number; icon: IconName }[] = [
          { label: 'Data Spaces', value: inventory.dataSpaces.length, icon: 'layers' },
          { label: 'Data Lake Objects', value: inventory.dlos.length, icon: 'database' },
          { label: 'Data Model Objects', value: inventory.dmos.length, icon: 'cube' },
          { label: 'Mappings', value: inventory.mappings.length, icon: 'route' },
          { label: 'Data Transforms', value: inventory.dataTransforms.length, icon: 'sparkles' },
        ];
        const quickLinks: { label: string; description: string; page: Page; icon: IconName }[] = [
          { label: 'Data Spaces', description: 'Boundaries and ownership', page: 'data-spaces', icon: 'layers' },
          { label: 'DLO Explorer', description: 'Raw ingested objects', page: 'dlos', icon: 'database' },
          { label: 'DMO Explorer', description: 'Unified model objects', page: 'dmos', icon: 'cube' },
          { label: 'Mapping Explorer', description: 'Source-to-target lineage', page: 'mappings', icon: 'route' },
          { label: 'Data Transform Explorer', description: 'Batch and streaming transforms', page: 'data-transforms', icon: 'sparkles' },
          { label: 'ERD Explorer', description: 'Relationships and certainty', page: 'erd', icon: 'graph' },
          { label: 'Data Dictionary', description: 'Fields and exports', page: 'dictionary', icon: 'book' },
        ];

        return (
          <div className="space-y-6">
            <ExportNotice mode={mode} />
            {exportMessage ? <p className="text-xs text-ink-soft" role="status">{exportMessage}</p> : null}
            <section className="panel hero-glow overflow-hidden">
              <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center lg:p-10">
                <div>
                  <Badge tone={mode === 'demo' ? 'warning' : 'success'} dot>
                    {mode === 'demo' ? 'Sample inventory' : 'Live org metadata'}
                  </Badge>
                  <h2 className="mt-5 max-w-2xl text-3xl leading-tight font-semibold tracking-tight text-ink sm:text-4xl">
                    Your Data 360 model, clearly mapped.
                  </h2>
                  <p className="mt-3 max-w-xl text-base text-ink-soft">
                    Trace data spaces through lake objects, model objects, and mappings — with provenance on every finding.
                  </p>
                  <div className="mt-7 flex flex-wrap gap-3">
                    <Button
                      variant="primary"
                      onClick={() => onNavigate('dlos')}
                      icon={<Icon name="arrowRight" size={17} />}
                    >
                      Explore the inventory
                    </Button>
                    <Button variant="secondary" onClick={() => onNavigate('orgs')} icon={<Icon name="plug" size={17} />}>
                      Manage connections
                    </Button>
                    <ExportMenu items={exportItems} />
                  </div>
                  <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                    <span>Read-only metadata</span>
                    <span aria-hidden="true">·</span>
                    <span>No credentials in the browser</span>
                    <span aria-hidden="true">·</span>
                    <span>Local-first</span>
                  </p>
                </div>

                <div className="rounded-xl border border-line bg-surface p-5 shadow-panel">
                  <div className="flex items-center justify-between gap-3">
                    <p className="label-xs">Inventory path</p>
                    <Icon name="graph" size={18} className="text-brand" />
                  </div>
                  <div className="mt-4 space-y-0">
                    {flowSteps.map((step, index) => (
                      <div key={step.label}>
                        <div className="flow-step">
                          <Icon name={step.icon} size={17} className="text-brand" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{step.label}</span>
                          <span className="text-sm font-semibold tabular-nums text-ink">{step.value}</span>
                        </div>
                        {index < flowSteps.length - 1 ? (
                          <div aria-hidden="true" className="ml-6 h-4 border-l border-dashed border-line-strong" />
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-xs text-ink-soft">
                    Generated {new Date(inventory.generatedAt).toLocaleString()} · API v{inventory.apiVersion ?? '—'}
                  </p>
                </div>
              </div>
            </section>

            <section aria-labelledby="inventory-metrics">
              <SectionHeading
                id="inventory-metrics"
                title="Inventory at a glance"
                description="Select a metric to open the matching explorer."
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {metrics.map((metric) => (
                  <button
                    key={metric.label}
                    type="button"
                    onClick={() => onNavigate(metric.page)}
                    className="metric-card"
                  >
                    <Icon name={metric.icon} size={18} className="text-brand" />
                    <span className="mt-3 text-2xl font-semibold tabular-nums text-ink">{metric.value}</span>
                    <span className="text-xs text-ink-soft">{metric.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <Panel>
              <SectionHeading
                title="Discovery stages"
                description="Each stage reflects the capability results in the current snapshot, not a guessed progress percentage."
                action={retryableCount > 0 && inventoryActions ? (
                  <Button
                    variant="secondary"
                    onClick={inventoryActions.refreshInventory}
                    disabled={inventoryActions.isRefreshingInventory}
                    icon={<Icon name="refresh" size={15} className={inventoryActions.isRefreshingInventory ? 'animate-spin' : undefined} />}
                  >
                    Retry {retryableCount} failed {retryableCount === 1 ? 'family' : 'families'}
                  </Button>
                ) : undefined}
              />
              <ol className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {stages.map((stage) => (
                  <li key={stage.id} className="rounded-lg border border-line bg-surface-alt px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-ink">{stage.label}</p>
                      <Badge tone={stageTone(stage.state)}>{statusLabel(stage.state)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">{stage.detail}</p>
                  </li>
                ))}
              </ol>
            </Panel>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.35fr_0.65fr]">
              <Panel>
                <SectionHeading
                  title="Discovery health"
                  description={`${summary.available} of ${summary.total} families available · ${summary.partial} partial${
                    summary.unsupported > 0 ? ` · ${summary.unsupported} not enabled` : ''
                  }`}
                  action={<Badge tone={summary.issues > 0 ? 'warning' : data360Unavailable ? 'neutral' : 'success'} dot>
                    {summary.label} · {summary.score}%
                  </Badge>}
                />
                {data360Unavailable ? (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-sm text-ink-soft" role="status">
                    <Icon name="info" size={16} className="mt-0.5 shrink-0 text-brand" />
                    <span>Data 360 is not enabled for this user or org. Ask an administrator to enable Data Cloud, then refresh the inventory.</span>
                  </div>
                ) : null}
                <div className="space-y-2">
                  {inventory.capabilities.map((capability) => (
                    <div
                      key={capability.family}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-alt px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{humanize(capability.family)}</p>
                        <p className="truncate text-xs text-ink-soft" title={capability.message ?? capability.endpoint}>
                          {resourceStatusMessage(capability)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs tabular-nums text-ink-faint">{capability.itemCount ?? 0} items</span>
                        <Badge tone={statusTone(capability.status)}>{humanize(capability.status)}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel>
                <SectionHeading
                  title="Needs attention"
                  description={attentionWarnings.length === 0
                    ? data360Unavailable ? 'No actionable gaps.' : 'No gaps reported during discovery.'
                    : `${attentionWarnings.length} items to review.`}
                />
                {attentionWarnings.length === 0 ? (
                  <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                    data360Unavailable
                      ? 'border-line bg-surface-alt text-ink-soft'
                      : 'border-success/20 bg-success-soft text-success'
                  }`}>
                    <Icon name={data360Unavailable ? 'info' : 'check'} size={17} />
                    <span>
                      {data360Unavailable
                        ? 'Data 360 is not enabled for this user or org. The unavailable families are listed in Discovery health; no retry is needed.'
                        : 'Nothing needs attention. All requested metadata families were retrieved.'}
                    </span>
                  </div>
                ) : (
                  <ul className="space-y-2.5">
                    {attentionWarnings.map((warning, index) => (
                      <li key={`${warning.family}-${warning.code}-${index}`} className="rounded-lg border border-line bg-surface-alt px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={warning.severity === 'error' ? 'danger' : warning.severity === 'warning' ? 'warning' : 'neutral'}>
                            {humanize(warning.family)}
                          </Badge>
                          <span className="text-xs text-ink-faint">{warning.code}</span>
                        </div>
                        <p className="mt-1.5 text-sm text-ink-soft">{warning.message}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <Panel>
              <SectionHeading title="Go deeper" description="Every view is backed by the same inventory snapshot." />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {quickLinks.map((link) => (
                  <button
                    key={link.page}
                    type="button"
                    onClick={() => onNavigate(link.page)}
                    className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-alt"
                  >
                    <Icon name={link.icon} size={18} className="text-brand" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{link.label}</span>
                      <span className="block truncate text-xs text-ink-soft">{link.description}</span>
                    </span>
                    <Icon name="arrowRight" size={15} className="text-ink-faint" />
                  </button>
                ))}
              </div>
            </Panel>
          </div>
        );
      }}
    </InventoryBoundary>
  );
}
