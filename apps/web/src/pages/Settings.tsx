import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import { ErrorState, LoadingState } from '../components/DataStates.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, Panel, SectionHeading } from '../components/ui/index.ts';
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
];

export function Settings({ theme }: { theme: ThemeController }) {
  const queryClient = useQueryClient();
  const [refreshError, setRefreshError] = useState('');
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const bridgeQuery = useQuery({ queryKey: ['bridge-status'], queryFn: api.bridgeStatus, refetchInterval: 30_000 });
  const refreshCli = useMutation({
    mutationFn: api.refreshCli,
    onSuccess: () => {
      setRefreshError('');
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      void queryClient.invalidateQueries({ queryKey: ['bridge-status'] });
    },
    onError: (error: Error) => setRefreshError(error.message),
  });

  if (healthQuery.isPending) return <LoadingState label="Reading connector diagnostics…" />;
  if (healthQuery.isError) {
    return <ErrorState message={healthQuery.error.message} onRetry={() => void healthQuery.refetch()} />;
  }

  const health = healthQuery.data;
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
        description="Local bridge health and the privacy boundaries enforced by this toolkit."
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
    </>
  );
}
