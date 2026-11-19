import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { invalidateBridgeState } from '../lib/workspace.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import { ErrorState, LoadingState } from '../components/DataStates.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, ConfirmDialog, Panel, SectionHeading } from '../components/ui/index.ts';
import type { ThemeController } from '../lib/useTheme.ts';
import type { ThemePreference } from '../lib/preferences.ts';

const themeOptions: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

const privacyItems: { icon: IconName; text: string }[] = [
  { icon: 'lock', text: 'No access tokens, refresh tokens, passwords, or SFDX auth URLs are requested or stored.' },
  { icon: 'shield', text: 'No customer records are queried. Only metadata and schema information are retrieved.' },
  { icon: 'database', text: 'The browser runs no CLI commands; the local bridge executes only allowlisted typed operations.' },
  { icon: 'check', text: 'Demo fixtures are clearly labelled and never mixed with live org results.' },
  { icon: 'database', text: 'Loaded metadata can be cached in this browser, but tokens and pairing codes are never persisted.' },
];

interface SettingsProps {
  theme: ThemeController;
  onClearCachedMetadata: () => Promise<void>;
  onResetSavedLayouts: () => void;
  onEraseLocalData: () => Promise<void>;
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function Settings({ theme, onClearCachedMetadata, onResetSavedLayouts, onEraseLocalData }: SettingsProps) {
  const queryClient = useQueryClient();
  const [refreshError, setRefreshError] = useState('');
  const [dataNotice, setDataNotice] = useState('');
  const [dataError, setDataError] = useState('');
  const [eraseOpen, setEraseOpen] = useState(false);
  const [erasing, setErasing] = useState(false);
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const bridgeQuery = useQuery({ queryKey: ['bridge-status'], queryFn: api.bridgeStatus, refetchInterval: 30_000 });
  const refreshCli = useMutation({
    mutationFn: api.refreshCli,
    onSuccess: () => {
      setRefreshError('');
      invalidateBridgeState(queryClient);
    },
    onError: (error: Error) => setRefreshError(error.message),
  });

  if (healthQuery.isPending && !healthQuery.data) return <LoadingState label="Reading connector diagnostics…" />;
  // A failed background poll must not replace the rest of Settings: React Query
  // keeps the last good health payload, so the panels can stay usable.
  if (healthQuery.isError && !healthQuery.data) {
    return <ErrorState message={healthQuery.error.message} onRetry={() => void healthQuery.refetch()} />;
  }
  const health = healthQuery.data;
  if (!health) return <LoadingState label="Reading connector diagnostics…" />;

  const clearMetadata = async () => {
    setDataNotice('');
    setDataError('');
    try {
      await onClearCachedMetadata();
      setDataNotice('Cached metadata cleared. DCAT is loading fresh metadata.');
    } catch (error) {
      setDataError(actionError(error, 'Could not clear cached metadata.'));
    }
  };

  const resetLayouts = () => {
    setDataNotice('');
    setDataError('');
    onResetSavedLayouts();
    setDataNotice('Saved ERD and Lineage layouts reset for every org.');
  };

  const eraseData = async () => {
    setErasing(true);
    setDataError('');
    try {
      await onEraseLocalData();
      setEraseOpen(false);
      setDataNotice('All local data erased. Preferences are back to defaults.');
    } catch (error) {
      setDataError(actionError(error, 'Could not erase local data.'));
    } finally {
      setErasing(false);
    }
  };

  const bridge = bridgeQuery.data;
  const bridgeTone: BadgeTone = bridge?.relay === 'connected'
    ? 'success'
    : bridge?.relay === 'stale'
      ? 'danger'
      : bridge?.paired
        ? 'warning'
        : 'neutral';
  const bridgeLabel = bridge?.relay === 'connected'
    ? 'Connected'
    : bridge?.relay === 'stale'
      ? 'Offline'
      : bridge?.paired
        ? 'Waiting'
        : 'Not paired';
  const facts = [
    { label: 'Status', value: <Badge tone={health.status === 'ok' ? 'success' : 'warning'} dot>{health.status}</Badge> },
    { label: 'Mode', value: <Badge tone={health.mode === 'demo' ? 'warning' : 'success'}>{health.mode}</Badge> },
    { label: 'Bridge version', value: health.version },
    { label: 'Checked at', value: new Date(health.time).toLocaleString() },
    {
      label: 'Salesforce CLI',
      value: health.cli.installed ? health.cli.version ?? 'Detected' : 'Not detected',
    },
    {
      label: 'Local bridge',
      value: <Badge tone={bridgeTone} dot>{bridgeLabel}</Badge>,
    },
    {
      label: 'Last check-in',
      value: bridge?.lastSeenAt ? new Date(bridge.lastSeenAt).toLocaleString() : '—',
    },
  ];

  return (
    <>
      <PageIntro
        title="Settings & Diagnostics"
        description="Bridge health, appearance, and the data DCAT keeps in this browser."
      />

      <div className="grid gap-5 xl:grid-cols-2">
        {refreshError ? (
          <div className="xl:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2.5 text-sm text-danger" role="alert">
            <span>{refreshError}</span>
            <button
              type="button"
              onClick={() => {
                setRefreshError('');
                refreshCli.mutate();
              }}
              className="font-semibold underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : null}
        <Panel>
          <SectionHeading
            title="Local bridge"
            description="Runs on your computer and sends only typed operations to the site."
            action={
              <Button
                variant="secondary"
                onClick={() => refreshCli.mutate()}
                disabled={refreshCli.isPending}
                icon={<Icon name="refresh" size={15} />}
              >
                {refreshCli.isPending ? 'Checking…' : 'Re-check CLI'}
              </Button>
            }
          />
          {healthQuery.isError ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-sm text-warning" role="alert">
              <Icon name="warning" size={16} />
              <span>Diagnostics refresh failed: {healthQuery.error.message} Showing the last successful check.</span>
              <button
                type="button"
                onClick={() => void healthQuery.refetch()}
                className="font-semibold underline underline-offset-2"
              >
                Try again
              </button>
            </div>
          ) : null}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.label} className="rounded-lg bg-surface-alt px-3 py-2.5">
                <dt className="label-xs">{fact.label}</dt>
                <dd className="mt-1 text-ink">{fact.value}</dd>
              </div>
            ))}
          </dl>
          {health.cli.error ? (
            <p className="mt-4 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-sm text-warning">
              {health.cli.error}
            </p>
          ) : null}
          {bridgeQuery.isError ? (
            <p className="mt-4 text-sm text-warning" role="alert">Bridge status is unavailable. Refresh to try again.</p>
          ) : null}
        </Panel>

        <Panel>
          <SectionHeading title="Appearance" description="Switch themes here or use the toggle in the header." />
          <div
            className="inline-flex rounded-lg border border-line bg-surface-alt p-1"
            role="group"
            aria-label="Theme preference"
          >
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => theme.choose(option.value)}
                aria-pressed={theme.preference === option.value}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  theme.preference === option.value
                    ? 'bg-brand-soft text-brand'
                    : 'text-ink-soft hover:bg-surface hover:text-ink'
                }`}
              >
                <Icon name={option.icon} size={16} />
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            Currently showing the <span className="font-medium text-ink-soft">{theme.resolved}</span> theme.
            {theme.preference === 'system' ? ' Follows your device preference automatically.' : ''}
          </p>
        </Panel>

        <Panel className="xl:col-span-2">
          <SectionHeading
            title="Stored data"
            description="What stays in this browser, and how to remove it."
          />
          <p className="mt-1 text-sm text-ink-soft">
            DCAT caches org lists and loaded inventory snapshots here for up to 7 days so reloads are fast.
            It also remembers your mode, selected org, hidden orgs, theme, sidebar state, and ERD/Lineage layouts.
            Access tokens, pairing codes, and customer records are never persisted.
          </p>
          {dataNotice ? (
            <p className="mt-4 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-sm text-success" role="status">
              {dataNotice}
            </p>
          ) : null}
          {dataError ? (
            <p className="mt-4 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
              {dataError}
            </p>
          ) : null}
          <div className="mt-4 divide-y divide-line rounded-lg border border-line">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Clear cached metadata</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Deletes saved org lists and inventory snapshots. DCAT fetches fresh metadata for the current workspace;
                  your preferences stay as they are.
                </p>
              </div>
              <Button variant="secondary" onClick={() => void clearMetadata()} icon={<Icon name="refresh" size={15} />}>
                Clear cached metadata
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Reset saved layouts</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Deletes ERD and Lineage filters, node positions, and viewports for every org. Metadata and other
                  preferences stay.
                </p>
              </div>
              <Button variant="secondary" onClick={resetLayouts} icon={<Icon name="graph" size={15} />}>
                Reset saved layouts
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Erase all local data</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Deletes cached metadata and every DCAT preference in this browser. The app returns to Demo mode and
                  clears your saved org selection. This does not sign you out or change bridge pairing or Salesforce CLI
                  authentication.
                </p>
              </div>
              <Button variant="danger" onClick={() => { setDataNotice(''); setEraseOpen(true); }} icon={<Icon name="warning" size={15} />}>
                Erase all local data
              </Button>
            </div>
          </div>
        </Panel>

        <Panel className="xl:col-span-2">
          <SectionHeading title="Privacy and data handling" description="Designed for architecture discovery, not record access." />
          <ul className="space-y-3 text-sm text-ink-soft">
            {privacyItems.map((item) => (
              <li key={item.text} className="flex items-start gap-3">
                <Icon name={item.icon} size={17} className="mt-0.5 text-brand" />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {eraseOpen ? (
        <ConfirmDialog
          title="Erase all local data?"
          description={
            <>
              <p>This removes everything DCAT has saved in this browser:</p>
              <ul className="mt-2 list-inside list-disc space-y-1">
                <li>Cached org lists and inventory snapshots</li>
                <li>Mode, selected org, and hidden orgs</li>
                <li>Theme, sidebar state, and saved ERD/Lineage layouts</li>
              </ul>
            </>
          }
          consequences={
            <div className="space-y-2 rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-xs text-ink-soft">
              <p className="font-medium text-ink">This does not touch:</p>
              <p>Bridge pairing or the local bridge installation · Salesforce CLI authentication · Your sign-in</p>
              <p>
                Cached metadata will be fetched again. Saved preferences return to defaults and cannot be restored.
              </p>
            </div>
          }
          confirmLabel="Erase all local data"
          cancelLabel="Keep my data"
          busy={erasing}
          onConfirm={() => void eraseData()}
          onClose={() => { if (!erasing) setEraseOpen(false); }}
        />
      ) : null}
    </>
  );
}
