import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BridgeStatus, OrgSummary, SessionInfo } from '@dcat/core';
import { api, ApiError } from '../lib/api.ts';
import { isHosted } from '../lib/hosted.ts';
import { orgsQueryOptions } from '../lib/queryPersistence.ts';
import { describeError, sanitizeDetail } from '../lib/userError.ts';
import { invalidateBridgeState, invalidateDiagnosticsState, orgsQueryKey } from '../lib/workspace.ts';
import type { WorkspaceMode } from '../lib/workspace.ts';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates.tsx';
import { Icon } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Button, CopyButton, DataTable, Panel } from '../components/ui/index.ts';
import type { DataTableColumn } from '../components/ui/index.ts';

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const manualUpdateCommand = 'npm install -g @dcat-toolkit/bridge@latest';
const bridgeStartCommand = 'npx -y @dcat-toolkit/bridge@latest start';

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
  mode: WorkspaceMode;
  selectedAlias: string | null;
  onSelect: (alias: string) => void;
  hiddenAliases: readonly string[];
  onRemoveOrg: (alias: string) => void;
  onRestoreOrg: (alias: string) => void;
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
  if (status === undefined) return 'Checking...';
  if (hosted && !status.paired) return 'Bridge not paired';
  if (installed === false || status.cli.installed === false) return 'SF CLI missing';
  if (!hosted) return 'SF CLI ready';
  if (status.relay === 'unavailable') return 'Status unavailable';
  if (status.relay === 'stale') return 'Bridge offline';
  if (status.relay === 'working') return 'Bridge working';
  if (status.relay === 'waiting') return 'Waiting for bridge';
  return 'Bridge connected';
}

interface SetupNotice {
  tone: 'warning' | 'brand';
  title: string;
  lines: string[];
  command?: string;
  copyLabel?: string;
  repair?: boolean;
}

/** One state-appropriate card: never stack competing update and recovery steps. */
function setupNotice(status: BridgeStatus, hosted: boolean): SetupNotice | null {
  if (!hosted || !status.paired) return null;
  if (status.relay === 'unavailable') {
    return {
      tone: 'warning',
      title: 'Bridge status is temporarily unavailable.',
      lines: ['Refresh status to retry. If it stays unavailable, create a fresh pairing code and rerun setup. Creating a code resets the current pairing.'],
      repair: true,
    };
  }
  if (status.relay === 'working') {
    return {
      tone: 'brand',
      title: 'The bridge is running a long operation.',
      lines: ['It will check in again when it finishes. The API version stays unchanged until then.'],
    };
  }
  if (status.relay === 'stale') {
    return {
      tone: 'warning',
      title: 'The bridge stopped responding.',
      lines: [status.canRepairPairing
        ? 'Restart it on this computer with the command below. If it still does not reconnect, create a fresh pairing code.'
        : 'Restart it on this computer with the command below.'],
      command: bridgeStartCommand,
      copyLabel: 'Copy start command',
      repair: status.canRepairPairing,
    };
  }
  if (status.relay === 'waiting') {
    return {
      tone: 'warning',
      title: 'Bridge paired. Waiting for its first check-in.',
      lines: ['Keep this command running on this computer:'],
      command: bridgeStartCommand,
      copyLabel: 'Copy start command',
      repair: status.canRepairPairing,
    };
  }
  if (status.updateAvailable) {
    return {
      tone: 'warning',
      title: `Bridge update available${status.latestVersion ? ` · ${status.latestVersion}` : ''}`,
      lines: [
        `Running ${status.agentVersion ?? 'an older version'}. Run the command below, then restart the bridge. If you already installed it, just restart the bridge.`,
      ],
      command: manualUpdateCommand,
      copyLabel: 'Copy command',
    };
  }
  return null;
}

export function OrgConnections({
  mode,
  selectedAlias,
  onSelect,
  hiddenAliases,
  onRemoveOrg,
  onRestoreOrg,
}: OrgConnectionsProps) {
  const queryClient = useQueryClient();
  const hosted = isHosted();
  const demo = mode === 'demo';
  const [newAlias, setNewAlias] = useState('my-data360-org');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [loginBrowser, setLoginBrowser] = useState<'' | 'chrome' | 'edge' | 'firefox'>('');
  const [setupError, setSetupError] = useState('');
  const [connectError, setConnectError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [connectedAlias, setConnectedAlias] = useState<string | null>(null);
  const [confirmingAlias, setConfirmingAlias] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [removalNotice, setRemovalNotice] = useState('');
  const connectStarted = useRef(false);
  const connectController = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const aliasInputId = useId();
  const instanceInputId = useId();
  const browserSelectId = useId();

  const bridgeStatusQuery = useQuery({
    queryKey: ['bridge-status'],
    queryFn: api.bridgeStatus,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (status?.paired && status.relay === 'connected' && status.cli.installed) return 60_000;
      if (status?.paired && status.relay === 'working') return 5_000;
      return 10_000;
    },
  });
  // The App root also observes the mode-scoped org list. In hosted live mode,
  // only start this observer once a bridge is paired so a second org.list cannot
  // be enqueued after a connect request and delay the first inventory load.
  // Demo mode uses fixtures, so it never needs this guard.
  const bridgeStatus = bridgeStatusQuery.data;
  const orgsQuery = useQuery({
    queryKey: orgsQueryKey(mode),
    queryFn: ({ signal }) => api.orgs({ signal }),
    enabled: !hosted || demo || bridgeStatus?.mode === 'demo' || bridgeStatus?.paired === true,
    ...orgsQueryOptions(hosted),
  });

  const invalidateSetup = () => invalidateBridgeState(queryClient);

  const refreshStatus = useMutation({
    mutationFn: async () => {
      // Hosted status is a read-only relay check; local status re-runs the CLI probe.
      if (hosted) return api.checkBridgeStatus();
      await api.refreshCli();
      return api.bridgeStatus();
    },
    onSuccess: async (next) => {
      // A passive status read already in flight can resolve after this mutation
      // and overwrite the checked result. Cancel it before writing the snapshot.
      await queryClient.cancelQueries({ queryKey: ['bridge-status'] });
      queryClient.setQueryData<BridgeStatus>(['bridge-status'], next);
      setSetupError('');
      if (hosted) void queryClient.invalidateQueries({ queryKey: ['health'] });
      else invalidateDiagnosticsState(queryClient);
    },
    onError: (error: Error) => {
      const described = describeError(error, 'setup');
      setSetupError(`${described.message}${described.hint ? ` ${described.hint}` : ''}`);
    },
  });

  const createPairing = useMutation({
    mutationFn: async () => {
      if (bridgeStatusQuery.data?.paired) await api.unpairBridge();
      return api.relayPairing();
    },
    onSuccess: () => setSetupError(''),
    onError: (error: Error) => {
      const described = describeError(error, 'setup');
      setSetupError(`${described.message}${described.hint ? ` ${described.hint}` : ''}`);
    },
    // If unpairing succeeded but pairing failed, the cached status still says
    // "paired". Refetch it on every outcome so recovery does not wait for a poll.
    onSettled: () => invalidateSetup(),
  });

  // The page remounts on a mode switch, so the captured `mode` prop is not
  // authoritative for a mutation that started before the switch.
  const currentMode = () => queryClient.getQueryData<SessionInfo>(['session'])?.mode ?? mode;

  useEffect(() => () => {
    connectController.current?.abort();
    refreshController.current?.abort();
  }, []);

  const connectOrg = useMutation({
    mutationFn: async (mutationMode: WorkspaceMode) => {
      const controller = new AbortController();
      connectController.current = controller;
      try {
        return {
          org: await api.connectOrg(newAlias, instanceUrl, loginBrowser || undefined, { signal: controller.signal }),
          mutationMode,
        };
      } finally {
        if (connectController.current === controller) connectController.current = null;
      }
    },
    onMutate: () => {
      connectStarted.current = true;
    },
    onSuccess: ({ org, mutationMode }) => {
      if (mutationMode !== currentMode()) return;
      setConnectError('');
      setConnectedAlias(org.alias);
      // Seed the shared org cache before selection so the workbench has a
      // context immediately. Do not invalidate the org list here: an invalidated
      // observer can refetch on a later mount and put a blocking `org.list`
      // between the connect request and the first inventory load.
      queryClient.setQueryData<OrgSummary[]>(orgsQueryKey(mutationMode), (current = []) => [
        org,
        ...current.filter((entry) => entry.alias !== org.alias),
      ]);
      // Reconnecting an alias is the explicit way to bring a removed org back.
      onRestoreOrg(org.alias);
      onSelect(org.alias);
    },
    onError: (error: Error, mutationMode) => {
      if (mutationMode !== currentMode() || error instanceof ApiError && error.code === 'ABORTED') return;
      const described = describeError(error, 'connect');
      setConnectError(`${described.message}${described.hint ? ` ${described.hint}` : ''}`);
    },
    onSettled: () => {
      connectStarted.current = false;
    },
  });

  const refreshOrgs = useMutation({
    mutationFn: async (mutationMode: WorkspaceMode) => {
      const controller = new AbortController();
      refreshController.current = controller;
      try {
        return {
          orgs: await api.refreshOrgs({ signal: controller.signal }),
          mutationMode,
        };
      } finally {
        if (refreshController.current === controller) refreshController.current = null;
      }
    },
    onSuccess: ({ orgs, mutationMode }) => {
      if (mutationMode !== currentMode()) return;
      // This is the explicit user refresh: replace the persisted list with the
      // newly retrieved one instead of waiting for an observer-mount refetch.
      setRefreshError('');
      queryClient.setQueryData<OrgSummary[]>(orgsQueryKey(mutationMode), orgs);
      invalidateBridgeState(queryClient);
    },
    onError: (error: Error, mutationMode) => {
      if (mutationMode !== currentMode() || error instanceof ApiError && error.code === 'ABORTED') return;
      const refreshDescription = describeError(error, 'refresh');
      setRefreshError(`${refreshDescription.message}${refreshDescription.hint ? ` ${refreshDescription.hint}` : ''}`);
    },
  });

  const status = bridgeStatusQuery.data;
  const cliInstalled = status?.cli.installed ?? null;
  const bridgeReady = hosted
    ? Boolean(status?.paired && (status.relay === 'connected' || status.relay === 'working') && status.cli.installed)
    : Boolean(status?.cli.installed);
  const setupState = setupLabel(status, hosted, cliInstalled);
  const bridgeOffline = hosted && Boolean(status?.paired)
    && (status?.relay === 'stale' || status?.relay === 'unavailable' || status?.relay === 'waiting');
  const notice = status && !demo ? setupNotice(status, hosted) : null;
  // The session mode is authoritative; a cached bridge payload can briefly
  // describe the previous mode after a switch.
  const liveMode = hosted && mode === 'live';
  // Hosted refresh reads the relay snapshot; local refresh re-runs the installed CLI.
  const statusRefreshLabel = !demo && hosted ? 'Refresh status' : 'Re-check CLI';
  // The shared cache can briefly contain fixtures from a prior mode switch.
  const candidateOrgs = (orgsQuery.data ?? []).filter(
    (org) => !liveMode || org.source !== 'demo-fixture',
  );
  const activeOrgs = candidateOrgs.filter((org) => !hiddenAliases.includes(org.alias));
  const hiddenOrgs = candidateOrgs.filter((org) => hiddenAliases.includes(org.alias));
  const step2Done = Boolean(connectedAlias)
    || activeOrgs.some((org) => org.connectedStatus === 'Connected');
  const inventoryLocked = liveMode && (!bridgeReady || !step2Done);
  // `isFetching` covers both the first load and the refetch after a mode switch,
  // when the shared cache was seeded with an empty list and `isPending` is false.
  const orgListChecking = orgsQuery.isFetching;
  const orgListReady = !orgListChecking && !orgsQuery.isError;

  useEffect(() => {
    if (confirmingAlias && !activeOrgs.some((org) => org.alias === confirmingAlias)) {
      setConfirmingAlias(null);
    }
  }, [activeOrgs, confirmingAlias]);

  const removeOrg = (alias: string) => {
    onRemoveOrg(alias);
    setConfirmingAlias(null);
    setRemovalNotice(`${alias} is hidden from DCAT only. Salesforce CLI authentication is unchanged.`);
    if (connectedAlias === alias) setConnectedAlias(null);
  };

  const restoreOrg = (alias: string) => {
    onRestoreOrg(alias);
    setRemovalNotice(`${alias} is visible in DCAT again.`);
  };
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
    { key: 'username', header: 'Username', render: (org) => <span className="text-ink-soft">{org.username ?? '-'}</span> },
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
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            variant={selectedAlias === org.alias ? 'primary' : 'secondary'}
            onClick={() => onSelect(org.alias)}
            className="px-2.5 py-1 text-xs"
            aria-label={selectedAlias === org.alias ? `${org.alias} selected` : `Select ${org.alias}`}
          >
            {selectedAlias === org.alias ? 'Selected' : 'Select'}
          </Button>
          {confirmingAlias === org.alias ? (
            <>
              <span className="text-xs text-ink-soft">Hide from DCAT?</span>
              <Button
                variant="primary"
                onClick={() => removeOrg(org.alias)}
                className="px-2.5 py-1 text-xs"
                aria-label={`Confirm remove ${org.alias}`}
              >
                Confirm
              </Button>
              <Button
                variant="quiet"
                onClick={() => setConfirmingAlias(null)}
                className="px-2.5 py-1 text-xs"
                aria-label={`Cancel remove ${org.alias}`}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="quiet"
              onClick={() => setConfirmingAlias(org.alias)}
              className="px-2.5 py-1 text-xs"
              aria-label={`Remove ${org.alias}`}
            >
              Remove
            </Button>
          )}
        </div>
      ),
    },
  ];

  const hiddenColumns: DataTableColumn<OrgSummary>[] = [
    {
      key: 'alias',
      header: 'Alias',
      render: (org) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{org.alias}</p>
          <Badge tone="neutral">Hidden in DCAT</Badge>
        </div>
      ),
    },
    { key: 'environment', header: 'Environment', render: (org) => org.environment },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      render: (org) => (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => restoreOrg(org.alias)}
            className="px-2.5 py-1 text-xs"
            aria-label={`Restore ${org.alias}`}
          >
            Restore
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageIntro
        title="Connect an org"
        description={demo
          ? 'Demo mode uses labelled sample data. Salesforce CLI, the bridge, and org connection are not needed.'
          : 'Set up the local SF CLI bridge once, connect your Salesforce org, then read its inventory here.'}
        meta={
          <Badge tone={demo ? 'neutral' : hosted ? 'brand' : 'neutral'} dot>
            {demo ? 'Demo mode' : hosted ? 'Live via local bridge' : 'Local Salesforce CLI'}
          </Badge>
        }
      />

      <div className="space-y-5">
        <Step
          number={1}
          title="Set up SF CLI"
          description={demo
            ? 'Not needed in demo mode. Sample metadata is already available.'
            : hosted
              ? 'Install DCAT Bridge on this computer. It opens an outbound connection to this site and runs the Salesforce CLI locally.'
              : 'DCAT uses the Salesforce CLI already installed on this computer.'}
          badge={demo
            ? <Badge tone="neutral" dot>Not needed in demo</Badge>
            : <>
                <Badge tone={bridgeReady ? 'success' : setupState === 'Checking...' ? 'neutral' : 'warning'} dot>
                  {setupState}
                </Badge>
                {!demo && ((hosted && status?.agentVersion) || status?.cli.version) ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
                    {hosted && status?.agentVersion ? (
                      <span title={bridgeOffline ? 'Last reported bridge version' : 'Installed DCAT bridge version'}>
                        Bridge <span className="mono text-ink">v{status.agentVersion}</span>
                        {bridgeOffline ? <span className="ml-1 text-ink-soft">(last reported)</span> : null}
                      </span>
                    ) : null}
                    {status?.cli.version ? (
                      <span title="Installed Salesforce CLI version">
                        SF CLI <span className="mono text-ink">v{status.cli.version}</span>
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </>}
          action={
            <Button
              variant="secondary"
              onClick={() => refreshStatus.mutate()}
              disabled={demo || refreshStatus.isPending}
              title={demo ? 'Not needed in demo mode' : undefined}
              icon={<Icon name="refresh" size={15} />}
            >
              {refreshStatus.isPending ? 'Checking...' : statusRefreshLabel}
            </Button>
          }
        >
          {demo ? (
            <p className="text-sm text-ink-soft">
              Demo mode runs on labelled sample data. No Salesforce CLI, bridge pairing, or org login is used.
              Switch to live mode to set up a real org.
            </p>
          ) : null}
          {!demo && bridgeStatusQuery.isPending ? <LoadingState label="Checking the local bridge..." /> : null}
          {!demo && bridgeStatusQuery.isError ? (
            <ErrorState
              message={describeError(bridgeStatusQuery.error, 'bridge').message}
              hint={describeError(bridgeStatusQuery.error, 'bridge').hint}
              onRetry={() => void bridgeStatusQuery.refetch()}
              retryLabel="Refresh status"
            />
          ) : null}

          {!demo && status && hosted && !status.paired && status.pairing ? (
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

          {notice ? (
            <div
              className={`space-y-2 rounded-lg border px-4 py-3 text-sm ${notice.tone === 'brand'
                ? 'border-brand/20 bg-brand-soft text-brand'
                : 'border-warning/20 bg-warning-soft text-warning'}`}
              role={notice.tone === 'brand' ? 'status' : 'alert'}
            >
              <p className="font-medium">{notice.title}</p>
              {notice.lines.map((line) => <p key={line}>{line}</p>)}
              {notice.command ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="mono min-w-0 flex-1 overflow-x-auto rounded border border-line bg-surface-alt px-2 py-1.5 text-xs text-ink">
                    {notice.command}
                  </code>
                  <CopyButton value={notice.command} label={notice.copyLabel ?? 'Copy command'} />
                </div>
              ) : null}
              {notice.repair ? (
                <Button
                  variant="secondary"
                  onClick={() => createPairing.mutate()}
                  disabled={createPairing.isPending}
                >
                  {createPairing.isPending ? 'Creating code...' : 'Create new pairing code'}
                </Button>
              ) : null}
            </div>
          ) : null}

          {!demo && status && !status.paired && !status.pairing && !createPairing.isPending ? (
            <Button variant="primary" onClick={() => createPairing.mutate()} disabled={createPairing.isPending}>
              Create pairing code
            </Button>
          ) : null}

          {!demo && status && !hosted && !status.cli.installed ? (
            <div className="rounded-lg border border-line bg-surface-alt p-4 text-sm text-ink-soft">
              <p>Install Salesforce CLI, then re-check.</p>
              <a className="mt-2 inline-flex items-center gap-1 font-medium text-brand underline underline-offset-2" href="https://developer.salesforce.com/docs/platform/salesforce-cli/guide/setup.html" target="_blank" rel="noopener noreferrer">
                Installation guide <Icon name="arrowRight" size={14} />
              </a>
            </div>
          ) : null}

          {!demo && status?.cli.error ? (
            <p className="mt-3 text-sm text-warning">
              {sanitizeDetail(status.cli.error, "Salesforce CLI is installed, but its version check failed. Re-check, or reinstall it if the problem continues.")}
            </p>
          ) : null}
          {!demo && setupError ? <p className="mt-3 text-sm text-danger" role="alert">{setupError}</p> : null}
        </Step>

        <Step
          number={2}
          title="Connect org"
          description={demo
            ? 'Not needed in demo mode. The sample orgs below are ready to explore.'
            : "Choose a local alias and start Salesforce CLI's browser login. Credentials are entered in that browser window, never in DCAT."}
          badge={demo
            ? <Badge tone="neutral">Not needed in demo</Badge>
            : bridgeReady ? undefined : <Badge tone="neutral">Complete step 1 first</Badge>}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block text-sm">
              <span className="font-medium text-ink">Org alias</span>
              <input
                id={aliasInputId}
                value={newAlias}
                disabled={demo}
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
                disabled={demo}
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
                disabled={demo}
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
                connectOrg.mutate(mode);
              }}
              disabled={demo || !bridgeReady || connectOrg.isPending || Boolean(aliasError || instanceError)}
              title={demo ? 'Not needed in demo mode' : undefined}
              icon={<Icon name="plug" size={15} />}
              aria-busy={connectOrg.isPending}
            >
              {connectOrg.isPending ? 'Waiting for login...' : 'Connect org'}
            </Button>
            {demo ? <span className="text-xs text-ink-soft">Org connection is not needed in demo mode.</span> : null}
            {!demo && !bridgeReady ? <span className="text-xs text-ink-soft">Connect org unlocks when SF CLI is ready.</span> : null}
            {!demo && bridgeReady ? <code className="mono min-w-0 flex-1 overflow-x-auto text-xs text-ink-soft">{loginCommand}</code> : null}
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
          badge={inventoryLocked ? <Badge tone="neutral">Complete steps 1 and 2 first</Badge> : undefined}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {hiddenOrgs.length > 0 ? (
                <Button
                  variant="quiet"
                  onClick={() => setShowHidden((current) => !current)}
                  aria-expanded={showHidden}
                >
                  {showHidden ? 'Hide removed orgs' : `Show removed orgs (${hiddenOrgs.length})`}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => refreshOrgs.mutate(mode)}
                disabled={refreshOrgs.isPending || inventoryLocked}
                icon={<Icon name="refresh" size={15} />}
              >
                {refreshOrgs.isPending ? 'Refreshing...' : 'Refresh org list'}
              </Button>
            </div>
          }
        >
          {removalNotice ? (
            <p className="mb-3 rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs text-ink-soft" role="status">
              {removalNotice}
            </p>
          ) : null}
          {refreshError ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
              <span>{refreshError}</span>
              <button
                type="button"
                onClick={() => {
                  setRefreshError('');
                  refreshOrgs.mutate(mode);
                }}
                className="font-semibold underline underline-offset-2"
              >
                Try again
              </button>
            </div>
          ) : null}
          {orgListChecking ? <LoadingState label="Checking for Salesforce orgs..." /> : null}
          {!orgListChecking && orgsQuery.isError ? (
            <ErrorState
              title="Couldn't check for Salesforce orgs"
              message={describeError(orgsQuery.error, 'orgs').message}
              hint={describeError(orgsQuery.error, 'orgs').hint}
              onRetry={() => void orgsQuery.refetch()}
              retryLabel="Retry org check"
            />
          ) : null}
          {orgListReady && inventoryLocked && !bridgeReady ? (
            <EmptyState
              icon="plug"
              title="Finish setup to view live inventory"
              description="Connect the local bridge in step 1, then authenticate an org in step 2. Demo mode works without setup."
            />
          ) : null}
          {orgListReady && inventoryLocked && bridgeReady ? (
            <EmptyState
              icon="plug"
              title="Connect an org to view live inventory"
              description="Authenticate an org in step 2. Its Data 360 metadata will appear here once the CLI reports it as connected."
            />
          ) : null}
          {orgListReady && !inventoryLocked && activeOrgs.length === 0 ? (
            <EmptyState
              icon="plug"
              title="No authenticated orgs yet"
              description={hiddenOrgs.length > 0
                ? 'All authenticated orgs are hidden from DCAT. Use Show removed orgs to restore one.'
                : demo
                  ? 'Demo sample orgs will appear here. Switch to live mode to connect a real org.'
                  : 'Connect an org in step 2 to load its inventory, or use demo mode to explore sample metadata.'}
            />
          ) : null}
          {orgListReady && !inventoryLocked && activeOrgs.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-line">
              <DataTable columns={columns} rows={activeOrgs} getRowKey={(org) => org.alias} ariaLabel="Authenticated Salesforce orgs" pageSize={50} />
            </div>
          ) : null}
          {orgListReady && showHidden && hiddenOrgs.length > 0 ? (
            <div className="mt-4 space-y-2 rounded-lg border border-line bg-surface-alt p-3">
              <p className="text-xs text-ink-soft">
                Hidden from DCAT only. Restoring an org does not change Salesforce CLI authentication.
              </p>
              <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                <DataTable columns={hiddenColumns} rows={hiddenOrgs} getRowKey={(org) => org.alias} ariaLabel="Orgs hidden from DCAT" pageSize={50} />
              </div>
            </div>
          ) : null}
        </Step>
      </div>
    </>
  );
}
