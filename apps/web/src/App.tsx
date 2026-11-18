import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventorySnapshot, OrgSummary, SessionInfo } from '@dcat/core';
import { api, getSession, setCachedSession } from './lib/api.ts';
import { buildCommandResults } from './lib/commandSearch.ts';
import { isHosted } from './lib/hosted.ts';
import type { CommandResult } from './lib/commandSearch.ts';
import { InventoryActionsProvider } from './lib/inventoryActions.tsx';
import { getModePreference, getSelectedOrg, setModePreference, setSelectedOrg } from './lib/preferences.ts';
import { useTheme } from './lib/useTheme.ts';
import { useInventory } from './lib/useInventory.ts';
import type { FocusObject } from './lib/objectDetail.ts';
import { clearWorkspaceCaches, createWorkspaceContext } from './lib/workspace.ts';
import type { WorkspaceMode } from './lib/workspace.ts';
import { AppShell } from './components/AppShell.tsx';
import { ErrorState, LoadingState } from './components/DataStates.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { OrgConnections } from './pages/OrgConnections.tsx';
import { Settings } from './pages/Settings.tsx';
import { DataSpaces } from './pages/DataSpaces.tsx';
import { DloExplorer, DmoExplorer } from './components/ObjectExplorer.tsx';
import { MappingExplorer } from './pages/MappingExplorer.tsx';
import { DataTransformExplorer } from './pages/DataTransformExplorer.tsx';
import { ErdExplorer } from './pages/ErdExplorer.tsx';
import { DataDictionary } from './pages/DataDictionary.tsx';
import type { Page } from './navigation.ts';

function BootScreen({ hosted, error, onRetry }: { hosted: boolean; error?: string; onRetry?: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand text-on-brand">
            <svg aria-hidden="true" fill="none" height={22} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24" width={22}>
              <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
              <path d="m19 15 .7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7L19 15Z" />
            </svg>
          </span>
          <div>
            <p className="font-semibold tracking-tight">DCAT</p>
            <p className="text-xs text-ink-soft">Data Cloud Architect Toolkit</p>
          </div>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : (
          <LoadingState label={hosted ? 'Loading the hosted workbench…' : 'Connecting to the local connector…'} />
        )}
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const hosted = isHosted();
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: Number.POSITIVE_INFINITY });
  // The Worker creates its session cookie on /api/session. Hosted queries wait
  // for that response so parallel first-load requests cannot create competing cookies.
  const sessionReady = Boolean(sessionQuery.data);
  const orgsQuery = useQuery({ queryKey: ['orgs'], queryFn: api.orgs, enabled: !hosted || sessionReady });
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    enabled: !hosted || sessionReady,
  });

  const [page, setPage] = useState<Page>('dashboard');
  const [selectedAlias, setSelectedAlias] = useState<string | null>(() => getSelectedOrg());
  const [modeNotice, setModeNotice] = useState('');
  const [modeError, setModeError] = useState('');
  const [focusObject, setFocusObject] = useState<FocusObject | null>(null);
  const modeAppliedRef = useRef<string | null>(null);
  const failedModeRef = useRef<WorkspaceMode>('demo');
  const theme = useTheme();

  const mode: WorkspaceMode = sessionQuery.data?.mode ?? 'demo';
  const selectedOrg = orgsQuery.data?.find((org) => org.alias === selectedAlias) ?? null;
  const context = createWorkspaceContext(mode, selectedOrg);
  const inventoryQuery = useInventory(context);
  const searchResults = useMemo(() => buildCommandResults(inventoryQuery.data ?? null), [inventoryQuery.data]);

  const { mutate: mutateMode, isPending: isTogglingMode } = useMutation({
    mutationFn: api.setMode,
    onSuccess: (result, requestedMode) => {
      // Drop the old context before the new mode renders, so sample data can
      // never appear under a Live label (or vice versa).
      clearWorkspaceCaches(queryClient, null);
      setFocusObject(null);
      const session = sessionQuery.data;
      if (session) {
        const nextSession: SessionInfo = { ...session, mode: result.mode };
        setCachedSession(nextSession);
        queryClient.setQueryData<SessionInfo>(['session'], nextSession);
      }
      setModePreference(requestedMode);
      setSelectedAlias(null);
      setSelectedOrg(null);
      // The connector exposes a different org list in each mode. Refresh it so
      // a mode switch cannot leave the UI stuck on the previous mode's orgs.
      void queryClient.invalidateQueries({ queryKey: ['orgs'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      setModeError('');
      setModeNotice(requestedMode === 'demo'
        ? 'Now using demo mode — sample metadata only.'
        : hosted
          ? 'Now using live mode — reading metadata through your local SF CLI bridge.'
          : 'Now using live mode — reading metadata from your Salesforce CLI.');
    },
    onError: (error, requestedMode) => {
      modeAppliedRef.current = null;
      failedModeRef.current = requestedMode;
      setModeError(`Couldn't switch to ${requestedMode} mode. ${error.message}`);
    },
  });

  const refreshInventory = useMutation({
    mutationFn: () => {
      if (!context?.alias) throw new Error('Select an org first.');
      return api.inventory(context.alias, { force: true });
    },
    onSuccess: (snapshot: InventorySnapshot) => {
      queryClient.setQueryData<InventorySnapshot>(['inventory', context?.contextId ?? 'none'], snapshot);
    },
  });

  // Feedback is transient: it confirms the switch without becoming permanent chrome.
  useEffect(() => {
    if (!modeNotice) return;
    const timer = window.setTimeout(() => setModeNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [modeNotice]);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    const storedPreference = getModePreference();
    const preferredMode = storedPreference ?? 'demo';
    if (session.mode === preferredMode) {
      if (!storedPreference) setModePreference(session.mode);
      return;
    }
    const transitionKey = `${session.mode}->${preferredMode}`;
    if (modeAppliedRef.current === transitionKey) return;
    modeAppliedRef.current = transitionKey;
    mutateMode(preferredMode);
    // `mutate` is stable; depending on the whole mutation object re-ran this
    // effect after every failure and created a retry loop.
  }, [sessionQuery.data, mutateMode]);

  useEffect(() => {
    const orgs = orgsQuery.data;
    if (!orgs) return;
    if (selectedAlias && orgs.some((org) => org.alias === selectedAlias)) return;
    const first = orgs[0] ?? null;
    clearWorkspaceCaches(queryClient, createWorkspaceContext(mode, first)?.contextId ?? null);
    setSelectedAlias(first?.alias ?? null);
    setSelectedOrg(first?.alias ?? null);
  }, [orgsQuery.data, selectedAlias, mode, queryClient]);

  if (sessionQuery.isPending) return <BootScreen hosted={hosted} />;
  if (sessionQuery.isError) {
    return (
      <BootScreen
        hosted={hosted}
        error={hosted
          ? `${sessionQuery.error.message} Reload the page to try again.`
          : `${sessionQuery.error.message} Start the connector with npm run dev before opening the UI.`}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  const selectOrg = (alias: string) => {
    // Read the cache directly: a just-connected org may be present before the
    // observing query has re-rendered, and inventory must start in this tick.
    const cachedOrgs = queryClient.getQueryData<OrgSummary[]>(['orgs']) ?? [];
    const next = createWorkspaceContext(mode, cachedOrgs.find((org) => org.alias === alias) ?? null);
    clearWorkspaceCaches(queryClient, next?.contextId ?? null);
    setFocusObject(null);
    setSelectedAlias(alias);
    setSelectedOrg(alias);
    setPage('dashboard');
  };

  const toggleMode = () => {
    modeAppliedRef.current = null;
    setModeError('');
    mutateMode(mode === 'demo' ? 'live' : 'demo');
  };

  const retryMode = () => {
    setModeError('');
    mutateMode(failedModeRef.current);
  };

  const selectSearchResult = (result: CommandResult) => {
    if (result.kind === 'transform') {
      setFocusObject({ kind: 'transform', apiName: result.apiName });
      setPage('data-transforms');
      return;
    }
    if (result.kind !== 'dlo' && result.kind !== 'dmo') return;
    setFocusObject({ kind: result.kind, apiName: result.apiName });
    setPage(result.kind === 'dlo' ? 'dlos' : 'dmos');
  };

  const content = (() => {
    switch (page) {
      case 'dashboard':
        return <Dashboard context={context} mode={mode} onNavigate={setPage} />;
      case 'orgs':
        return <OrgConnections selectedAlias={selectedAlias} onSelect={selectOrg} />;
      case 'settings':
        return <Settings theme={theme} />;
      case 'data-spaces':
        return <DataSpaces context={context} />;
      case 'dlos':
        return <DloExplorer context={context} focusObject={focusObject} onFocusHandled={() => setFocusObject(null)} />;
      case 'dmos':
        return <DmoExplorer context={context} focusObject={focusObject} onFocusHandled={() => setFocusObject(null)} />;
      case 'mappings':
        return <MappingExplorer context={context} />;
      case 'data-transforms':
        return (
          <DataTransformExplorer
            context={context}
            focusObject={focusObject}
            onFocusHandled={() => setFocusObject(null)}
          />
        );
      case 'erd':
        return <ErdExplorer context={context} />;
      case 'dictionary':
        return <DataDictionary context={context} />;
    }
  })();

  return (
    <InventoryActionsProvider
      value={{
        context,
        mode,
        onGoToOrgs: () => setPage('orgs'),
        onToggleMode: toggleMode,
        isTogglingMode,
        refreshInventory: () => refreshInventory.mutate(),
        isRefreshingInventory: refreshInventory.isPending,
        refreshError: refreshInventory.error?.message ?? '',
      }}
    >
      <AppShell
        page={page}
        onNavigate={setPage}
        context={context}
        onToggleMode={toggleMode}
        isTogglingMode={isTogglingMode}
        modeNotice={modeNotice}
        modeError={modeError}
        onRetryMode={retryMode}
        orgs={orgsQuery.data ?? []}
        selectedAlias={selectedAlias}
        onSelectOrg={selectOrg}
        onGoToOrgs={() => setPage('orgs')}
        cliInstalled={healthQuery.data?.cli.installed ?? null}
        cliVersion={healthQuery.data?.cli.version ?? null}
        theme={theme}
        searchResults={searchResults}
        onSelectSearchResult={selectSearchResult}
      >
        {/* Remounting on context change resets local filters, selection, and search. */}
        <div key={`${page}-${context?.contextId ?? 'none'}`} className="page-enter">{content}</div>
      </AppShell>
    </InventoryActionsProvider>
  );
}
