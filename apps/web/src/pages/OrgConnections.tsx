import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BridgeStatus, OrgSummary } from '@dcat/core';
import { api } from '../lib/api.ts';
import { isHosted } from '../lib/hosted.ts';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, CopyButton, DataTable, Panel } from '../components/ui/index.ts';
import type { DataTableColumn } from '../components/ui/index.ts';

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function validateInstanceUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return 'Use an https:// URL.';
    if (!/^[A-Za-z0-9.-]+\.salesforce\.com$/.test(url.hostname)) return 'Use a Salesforce My Domain URL.';
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      return 'Use only the base https://<domain>.salesforce.com URL.';
    }
    return null;
  } catch {
    return 'Enter a complete URL, for example https://mydomain--dev.sandbox.my.salesforce.com';
  }
}

interface OrgConnectionsProps {
  selectedAlias: string | null;
  onSelect: (alias: string) => void;
}

interface StepProps {
  number: number;
  title: string;
  description: string;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

function Step({ number, title, description, badge, action, children }: StepProps) {
  const headingId = `connect-step-${number}`;
  return (
    <Panel aria-labelledby={headingId}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
            {number}
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold tracking-tight text-ink">{title}</h2>
            <p className="mt-1 text-sm text-ink-soft">{description}</p>
            {badge ? <div className="mt-2 flex flex-wrap items-center gap-2">{badge}</div> : null}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Panel>
  );
}

function setupLabel(status: BridgeStatus | undefined, hosted: boolean, installed: boolean | null): string {
  if (status === undefined) return 'Checking…';
  if (installed === false || status.cli.installed === false) return 'SF CLI missing';
  if (!hosted) return 'SF CLI ready';
  if (!status.paired) return 'Bridge not paired';
  if (status.relay === 'stale') return 'Bridge offline';
  if (status.relay === 'waiting') return 'Waiting for bridge';
  return 'Bridge connected';
}

export function OrgConnections({ selectedAlias, onSelect }: OrgConnectionsProps) {
  const queryClient = useQueryClient();
  const hosted = isHosted();
  const [newAlias, setNewAlias] = useState('my-data360-org');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [loginBrowser, setLoginBrowser] = useState<'' | 'chrome' | 'edge' | 'firefox'>('');
  const [setupError, setSetupError] = useState('');
  const [connectError, setConnectError] = useState('');
  const [connectedAlias, setConnectedAlias] = useState<string | null>(null);
  const connectStarted = useRef(false);
  const aliasInputId = useId();
  const instanceInputId = useId();
  const browserSelectId = useId();

  const bridgeStatusQuery = useQuery({
    queryKey: ['bridge-status'],
    queryFn: api.bridgeStatus,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status || (status.paired && status.relay === 'connected' && status.cli.installed)) return 60_000;
      return 5_000;
    },
  });
  const orgsQuery = useQuery({ queryKey: ['orgs'], queryFn: api.orgs });

  const invalidateSetup = () => {
    void queryClient.invalidateQueries({ queryKey: ['bridge-status'] });
    void queryClient.invalidateQueries({ queryKey: ['health'] });
  };

  const refreshCli = useMutation({
    mutationFn: api.refreshCli,
    onSuccess: () => {
      setSetupError('');
      invalidateSetup();
    },
    onError: (error: Error) => setSetupError(error.message),
  });

  const createPairing = useMutation({
    mutationFn: async () => {
      if (bridgeStatusQuery.data?.paired) await api.unpairBridge();
      return api.relayPairing();
    },
    onSuccess: () => {
      setSetupError('');
      invalidateSetup();
    },
    onError: (error: Error) => setSetupError(error.message),
  });

  const connectOrg = useMutation({
    mutationFn: () => api.connectOrg(newAlias, instanceUrl, loginBrowser || undefined),
    onMutate: () => {
      connectStarted.current = true;
    },
    onSuccess: (org) => {
      setConnectError('');
      setConnectedAlias(org.alias);
      void queryClient.invalidateQueries({ queryKey: ['orgs'] });
      onSelect(org.alias);
    },
    onError: (error: Error) => setConnectError(error.message),
    onSettled: () => {
      connectStarted.current = false;
    },
  });

  const refreshOrgs = useMutation({
    mutationFn: api.refreshOrgs,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['orgs'] }),
  });

  const status = bridgeStatusQuery.data;
  const cliInstalled = status?.cli.installed ?? null;
  const bridgeReady = hosted
    ? Boolean(status?.paired && status.relay === 'connected' && status.cli.installed)
    : Boolean(status?.cli.installed);
  const setupState = setupLabel(status, hosted, cliInstalled);
  const instanceError = validateInstanceUrl(instanceUrl);
  const aliasError = aliasPattern.test(newAlias) ? null : 'Use letters, numbers, dots, dashes, underscores, or @.';
  const installCommand = status?.pairing?.installCommand ?? 'npx -y @dcat-toolkit/bridge@latest setup --relay <site-url> --code <code>';
  const loginCommand = `sf org login web --alias ${newAlias} --set-default${
    instanceUrl.trim() && !instanceError ? ` --instance-url ${instanceUrl.trim()}` : ''
  }${loginBrowser ? ` --browser ${loginBrowser}` : ''}`;

  const columns: DataTableColumn<OrgSummary>[] = [
    {
      key: 'alias',
      header: 'Alias',
      render: (org) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{org.alias}</p>
          {org.isDefault ? <Badge tone="brand">Default</Badge> : null}
        </div>
      ),
    },
    { key: 'username', header: 'Username', render: (org) => <span className="text-ink-soft">{org.username ?? '—'}</span> },
    { key: 'environment', header: 'Environment', render: (org) => org.environment },
    {
      key: 'status',
      header: 'Status',
      render: (org) => (
        <Badge tone={org.connectedStatus === 'Connected' ? 'success' : 'warning'} dot>
          {org.connectedStatus === 'Connected' ? 'Connected' : 'Check status'}
        </Badge>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      render: (org) => (
        <Button
          variant={selectedAlias === org.alias ? 'primary' : 'secondary'}
          onClick={() => onSelect(org.alias)}
          className="px-2.5 py-1 text-xs"
        >
          {selectedAlias === org.alias ? 'Selected' : 'Select'}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageIntro
        title="Connect an org"
        description="Set up the local SF CLI bridge once, connect your Salesforce org, then read its inventory here."
        meta={
          <Badge tone={hosted ? 'brand' : 'neutral'} dot>
            {hosted ? 'Live via local bridge' : 'Local Salesforce CLI'}
          </Badge>
        }
      />

      <div className="space-y-5">
        <Step
          number={1}
          title="Set up SF CLI"
          description={hosted
            ? 'Install DCAT Bridge on this computer. It opens an outbound connection to this site and runs the Salesforce CLI locally.'
            : 'DCAT uses the Salesforce CLI already installed on this computer.'}
          badge={
            <>
              <Badge tone={bridgeReady ? 'success' : setupState === 'Checking…' ? 'neutral' : 'warning'} dot>
                {setupState}
              </Badge>
              {status?.cli.version ? <span className="text-xs text-ink-soft">{status.cli.version}</span> : null}
            </>
          }
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
        >
          {bridgeStatusQuery.isPending ? <LoadingState label="Checking the local bridge…" /> : null}
          {bridgeStatusQuery.isError ? (
            <ErrorState message={bridgeStatusQuery.error.message} onRetry={() => void bridgeStatusQuery.refetch()} />
          ) : null}

          {status && hosted && !status.paired && status.pairing ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-line bg-surface-alt p-4">
                <p className="label-xs">One-time pairing code</p>
                <p className="mono mt-1 text-lg font-semibold tracking-widest text-ink">{status.pairing.code}</p>
                <p className="mt-1 text-xs text-ink-soft">
                  This code links this browser session only and expires at {new Date(status.pairing.expiresAt).toLocaleTimeString()}.
                </p>
              </div>
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Install command</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface-alt px-3 py-2.5 text-xs text-ink">
                    {status.pairing.installCommand}
                  </code>
                  <CopyButton value={status.pairing.installCommand} label="Copy" />
                </div>
              </div>
              <p className="flex items-start gap-2 text-xs text-ink-soft">
                <Icon name="lock" size={14} className="mt-0.5 text-brand" />
                The installer runs `sf` only through fixed, allowlisted commands. Never paste passwords, tokens, or SFDX auth URLs here.
              </p>
            </div>
          ) : null}

          {status && hosted && status.paired && status.relay !== 'connected' ? (
            <div className="space-y-2 rounded-lg border border-warning/20 bg-warning-soft px-4 py-3 text-sm text-warning">
              <p className="font-medium">
                {status.relay === 'stale' ? 'The bridge stopped responding.' : 'Bridge paired. Waiting for its first check-in.'}
              </p>
              <p>Keep the installer running with <code className="mono">npx -y @dcat-toolkit/bridge@latest start</code>, or create a fresh pairing code.</p>
              <Button
                variant="secondary"
                onClick={() => createPairing.mutate()}
                disabled={createPairing.isPending}
              >
                {createPairing.isPending ? 'Creating code…' : 'Create new pairing code'}
              </Button>
            </div>
          ) : null}

          {status && !status.paired && !status.pairing && !createPairing.isPending ? (
            <Button variant="primary" onClick={() => createPairing.mutate()} disabled={createPairing.isPending}>
              Create pairing code
            </Button>
          ) : null}

          {status && !hosted && !status.cli.installed ? (
            <div className="rounded-lg border border-line bg-surface-alt p-4 text-sm text-ink-soft">
              <p>Install Salesforce CLI, then re-check.</p>
              <a className="mt-2 inline-flex items-center gap-1 font-medium text-brand underline underline-offset-2" href="https://developer.salesforce.com/docs/platform/salesforce-cli/guide/setup.html" target="_blank" rel="noreferrer">
                Installation guide <Icon name="arrowRight" size={14} />
              </a>
            </div>
          ) : null}

          {status?.cli.error ? <p className="mt-3 text-sm text-warning">{status.cli.error}</p> : null}
          {setupError ? <p className="mt-3 text-sm text-danger" role="alert">{setupError}</p> : null}
        </Step>

        <Step
          number={2}
          title="Connect org"
          description="Choose a local alias and start Salesforce CLI's browser login. Credentials are entered in that browser window, never in DCAT."
          badge={bridgeReady ? undefined : <Badge tone="neutral">Complete step 1 first</Badge>}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="font-medium text-ink">Org alias</span>
              <input
                id={aliasInputId}
                value={newAlias}
                onChange={(event) => {
                  setNewAlias(event.target.value);
                  setConnectedAlias(null);
                }}
                className="input mono mt-1.5"
                aria-invalid={Boolean(aliasError)}
                aria-describedby={aliasError ? `${aliasInputId}-error` : undefined}
              />
              {aliasError ? <span id={`${aliasInputId}-error`} className="mt-1 block text-xs text-danger">{aliasError}</span> : null}
            </label>
            <label className="block text-sm">
              <span className="font-medium text-ink">Sandbox instance URL <span className="text-ink-faint">(optional)</span></span>
              <input
                id={instanceInputId}
                value={instanceUrl}
                onChange={(event) => {
                  setInstanceUrl(event.target.value);
                  setConnectedAlias(null);
                }}
                placeholder="https://mydomain--dev.sandbox.my.salesforce.com"
                className="input mt-1.5"
                aria-invalid={Boolean(instanceError)}
                aria-describedby={instanceError ? `${instanceInputId}-error` : undefined}
              />
              {instanceError ? <span id={`${instanceInputId}-error`} className="mt-1 block text-xs text-danger">{instanceError}</span> : null}
            </label>
            <label className="block text-sm">
              <span className="font-medium text-ink">Login browser <span className="text-ink-faint">(optional)</span></span>
              <select
                id={browserSelectId}
                value={loginBrowser}
                onChange={(event) => setLoginBrowser(event.target.value as '' | 'chrome' | 'edge' | 'firefox')}
                className="input mt-1.5"
              >
                <option value="">Default browser</option>
                <option value="chrome">Chrome</option>
                <option value="edge">Edge</option>
                <option value="firefox">Firefox</option>
              </select>
              <span className="mt-1 block text-xs text-ink-soft">Force a browser if the login window does not open.</span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={() => {
                if (connectStarted.current || connectOrg.isPending) return;
                connectOrg.mutate();
              }}
              disabled={!bridgeReady || connectOrg.isPending || Boolean(aliasError || instanceError)}
              icon={<Icon name="plug" size={15} />}
              aria-busy={connectOrg.isPending}
            >
              {connectOrg.isPending ? 'Waiting for login…' : 'Connect org'}
            </Button>
            {!bridgeReady ? <span className="text-xs text-ink-soft">Connect org unlocks when SF CLI is ready.</span> : null}
            {bridgeReady ? <code className="mono min-w-0 flex-1 overflow-x-auto text-xs text-ink-soft">{loginCommand}</code> : null}
          </div>

          {connectOrg.isPending ? (
            <div className="mt-3 rounded-lg border border-line bg-surface-alt px-4 py-3 text-sm text-ink-soft" role="status">
              <p>Salesforce CLI is opening a browser window on this computer. Complete the login there; DCAT receives only the org alias.</p>
              <p className="mt-1 text-xs">
                Keep the DCAT Bridge terminal running. If no login window appears within a few seconds, copy the command below and run it in a terminal.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="mono min-w-0 flex-1 overflow-x-auto text-xs text-ink">{loginCommand}</code>
                <CopyButton value={loginCommand} label="Copy" />
              </div>
            </div>
          ) : null}
          {connectedAlias && !connectOrg.isPending ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-success" role="status">
              <Icon name="check" size={16} />
              {connectedAlias} is connected. Loading its inventory now.
            </p>
          ) : null}
          {connectError ? <p className="mt-3 text-sm text-danger" role="alert">{connectError}</p> : null}
        </Step>

        <Step
          number={3}
          title="View inventory"
          description="Select an authenticated org to load its Data 360 metadata into the workbench."
          action={
            <Button
              variant="secondary"
              onClick={() => refreshOrgs.mutate()}
              disabled={refreshOrgs.isPending}
              icon={<Icon name="refresh" size={15} />}
            >
              {refreshOrgs.isPending ? 'Refreshing…' : 'Refresh org list'}
            </Button>
          }
        >
          {orgsQuery.isPending ? <LoadingState label="Reading org list…" /> : null}
          {orgsQuery.isError ? <ErrorState message={orgsQuery.error.message} onRetry={() => void orgsQuery.refetch()} /> : null}
          {orgsQuery.data?.length === 0 ? (
            <EmptyState
              icon="plug"
              title="No authenticated orgs yet"
              description="Connect an org in step 2 to load its inventory, or use demo mode to explore sample metadata."
            />
          ) : null}
          {orgsQuery.data && orgsQuery.data.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <DataTable columns={columns} rows={orgsQuery.data} getRowKey={(org) => org.alias} ariaLabel="Authenticated Salesforce orgs" />
            </div>
          ) : null}
        </Step>
      </div>
    </>
  );
}
