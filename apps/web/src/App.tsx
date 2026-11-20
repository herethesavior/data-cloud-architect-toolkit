import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsRestoring, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventorySnapshot, OrgSummary, ResourceFamily, SessionInfo } from '@dcat/core';
import { api, ApiError, getSession, setCachedSession } from './lib/api.ts';
import { clearDcatCachedMetadata, clearDcatLocalPreferences, clearDcatSavedLayouts } from './lib/localData.ts';
import { isHosted } from './lib/hosted.ts';
import { resetNoticeDismissals } from './lib/noticeDismissal.ts';
import type { CommandResult } from './lib/commandSearch.ts';
import { InventoryActionsProvider } from './lib/inventoryActions.tsx';
import type { OrgListState } from './lib/inventoryActions.tsx';
import {
  getHiddenOrgs,
  getModePreference,
  getSelectedOrg,
  setHiddenOrgs,
  setModePreference,
  setSelectedOrg,
} from './lib/preferences.ts';
import { orgsQueryOptions, persistedQueryOptions } from './lib/queryPersistence.ts';
import { useTheme } from './lib/useTheme.ts';
import { usePageMetadata } from './lib/seo.ts';
import { useInventory } from './lib/useInventory.ts';
import type { FocusObject } from './lib/objectDetail.ts';
import { clearWorkspaceCaches, createWorkspaceContext, invalidateWorkspaceState, orgsQueryKey } from './lib/workspace.ts';
import type { WorkspaceContext, WorkspaceMode } from './lib/workspace.ts';
import { AppShell } from './components/AppShell.tsx';
import { ErrorState, LoadingState } from './components/DataStates.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { OrgConnections } from './pages/OrgConnections.tsx';
import { Settings } from './pages/Settings.tsx';
import { DataSpaces } from './pages/DataSpaces.tsx';
import { DloExplorer, DmoExplorer } from './components/ObjectExplorer.tsx';
import { MappingExplorer } from './pages/MappingExplorer.tsx';
import { DataStreamExplorer } from './pages/DataStreamExplorer.tsx';
import { DataTransformExplorer } from './pages/DataTransformExplorer.tsx';
import { ErdExplorer } from './pages/ErdExplorer.tsx';
import { DataLineageExplorer } from './pages/DataLineageExplorer.tsx';
import { DataDictionary } from './pages/DataDictionary.tsx';
import { HelpPage } from './pages/HelpPage.tsx';
import { AboutPage } from './pages/AboutPage.tsx';
import { ChangeImpactAnalyzer } from './pages/ChangeImpactAnalyzer.tsx';
import { isLegacyPageHash, pageFromLocation, pagePath, writePagePath } from './navigation.ts';
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
  const isRestoring = useIsRestoring();
  const hosted = isHosted();
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: Number.POSITIVE_INFINITY });
  const mode: WorkspaceMode = sessionQuery.data?.mode ?? 'demo';
  // The Worker creates its session cookie on /api/session. Hosted queries wait
  // for that response so parallel first-load requests cannot create competing cookies.
  const sessionReady = Boolean(sessionQuery.data);
  const orgsQuery = useQuery({
    queryKey: orgsQueryKey(mode),
    queryFn: api.orgs,
    // The mode lives in the session response. Waiting for it prevents a live
    // reload from briefly retrieving orgs under the demo key.
    enabled: sessionReady,
    ...orgsQueryOptions(hosted),
  });

  const [page, setPage] = useState<Page>(() => pageFromLocation(window.location));
  const [selectedAlias, setSelectedAlias] = useState<string | null>(() => getSelectedOrg());
  const [hiddenAliases, setHiddenAliases] = useState<string[]>(() => getHiddenOrgs());
  const [modeNotice, setModeNotice] = useState('');
  const [modeError, setModeError] = useState('');
  // Remount the page subtree after a data action so mounted explorers rebuild
  // their observers against the newly fetched caches.
  const [dataEpoch, setDataEpoch] = useState(0);
  // Only a full erase changes this; a cache clear must not reset the sidebar.
  const [preferencesEpoch, setPreferencesEpoch] = useState(0);
  const [focusObject, setFocusObject] = useState<FocusObject | null>(null);

  const pageRef = useRef(page);
  pageRef.current = page;
  const navigate = useCallback((nextPage: Page) => {
    // Help tabs use ?topic= while the user stays on Help. Leaving that query
    // on other paths makes a later Help visit reopen an old tab, so drop it
    // only when actually changing pages.
    if (nextPage !== pageRef.current) {
      const url = new URL(window.location.href);
      if (url.searchParams.has('topic')) {
        url.searchParams.delete('topic');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }
    setPage(nextPage);
    writePagePath(nextPage);
  }, []);

  usePageMetadata(page);

  const modeAppliedRef = useRef<string | null>(null);
  const failedModeRef = useRef<WorkspaceMode>('demo');
  const theme = useTheme();

  const visibleOrgs = useMemo(
    () => (orgsQuery.data ?? []).filter((org) =>
      (mode !== 'live' || org.source !== 'demo-fixture') && !hiddenAliases.includes(org.alias)),
    [orgsQuery.data, mode, hiddenAliases],
  );
  const selectedOrg = visibleOrgs.find((org) => org.alias === selectedAlias) ?? null;
  const context = useMemo(() => createWorkspaceContext(mode, selectedOrg), [mode, selectedOrg]);
  const inventoryQuery = useInventory(context);
  const retryOrgs = useCallback(() => void orgsQuery.refetch(), [orgsQuery.refetch]);
  const orgList = useMemo<OrgListState>(() => {
    if (orgsQuery.isFetching) return { status: 'checking' };
    if (orgsQuery.isError) {
      return { status: 'error', message: orgsQuery.error.message, retry: retryOrgs };
    }
    return { status: 'idle' };
  }, [orgsQuery.isFetching, orgsQuery.isError, orgsQuery.error, retryOrgs]);

  const activeContextIdRef = useRef<string | null>(context?.contextId ?? null);
  activeContextIdRef.current = context?.contextId ?? null;
  const refreshControllerRef = useRef<AbortController | null>(null);
  const resumeControllerRef = useRef<AbortController | null>(null);
  const refreshContextRef = useRef<string | null>(context?.contextId ?? null);
  const modePendingRef = useRef(false);
  // Automatic writes resume only after an explicit post-erase choice. Otherwise
  // effects would immediately re-save the mode and org the erase just removed.
  const persistPreferencesRef = useRef(true);
  // Block the mode-restore effect while the erase is mid-flight: it would see a
  // demo session and the not-yet-erased live preference and switch back to live.
  const eraseInProgressRef = useRef(false);

  const cancelRefresh = () => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
  };

  // Context consumers should rerender for state changes, not because the root
  // created ten fresh callbacks on every progressive inventory snapshot.
  const actionsContextRef = useRef(context);
  const actionsInventoryRef = useRef(inventoryQuery.data);
  const toggleModeRef = useRef<() => void>(() => undefined);
  const retryModeRef = useRef<() => void>(() => undefined);
  const cancelRefreshRef = useRef(cancelRefresh);
  const refreshInventoryRef = useRef<() => void>(() => undefined);
  const resumeInventoryRef = useRef<(family?: ResourceFamily) => void>(() => undefined);
  actionsContextRef.current = context;
  actionsInventoryRef.current = inventoryQuery.data;
  cancelRefreshRef.current = cancelRefresh;

  const goToOrgs = useCallback(() => navigate('orgs'), [navigate]);
  const onToggleMode = useCallback(() => toggleModeRef.current(), []);
  const onRetryMode = useCallback(() => retryModeRef.current(), []);
  const onCancelRefresh = useCallback(() => cancelRefreshRef.current(), []);
  const onRefreshInventory = useCallback(() => refreshInventoryRef.current(), []);
  const onResumeDiscovery = useCallback((family?: ResourceFamily) => resumeInventoryRef.current(family), []);

  // Stop an in-flight refresh in the same tick as a context change. The query
  // cache clear alone cannot cancel a manually invoked inventory request, and a
  // late success could otherwise repopulate a cache that was just discarded.
  const resetWorkspaceState = (activeContextId: string | null) => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    resumeControllerRef.current?.abort();
    resumeControllerRef.current = null;
    refreshContextRef.current = activeContextId;
    clearWorkspaceCaches(queryClient, activeContextId);
  };

  const stopInFlightDiscovery = () => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    resumeControllerRef.current?.abort();
    resumeControllerRef.current = null;
  };

  const resumePreferencePersistence = () => {
    persistPreferencesRef.current = true;
  };

  // Scoped to re-fetchable data: dropping the session or diagnostics cache here
  // would flash a boot screen over a Settings action.
  const clearCachedMetadata = async () => {
    stopInFlightDiscovery();
    await clearDcatCachedMetadata(queryClient);
    setDataEpoch((value) => value + 1);
  };

  const resetSavedLayouts = () => {
    clearDcatSavedLayouts();
    setDataEpoch((value) => value + 1);
  };

  const { mutate: mutateMode, mutateAsync: setModeAsync, isPending: isTogglingMode } = useMutation({
    mutationFn: api.setMode,
    onSuccess: async (result, requestedMode) => {
      try {
        // Update the cached session first so the mode-aware org query cannot read
        // the previous mode's fixtures when it is re-enabled.
        const session = sessionQuery.data;
        if (session) {
          const nextSession: SessionInfo = { ...session, mode: result.mode };
          setCachedSession(nextSession);
          queryClient.setQueryData<SessionInfo>(['session'], nextSession);
        }
        // Cancel an in-flight org fetch before replacing the cache. Without
        // this, a late response could repopulate one mode's orgs under the other
        // mode's label. Removing the old mode also drops its persisted snapshot.
        const previousMode = session?.mode ?? mode;
        await queryClient.cancelQueries({ queryKey: orgsQueryKey(previousMode) });
        queryClient.removeQueries({ queryKey: orgsQueryKey(previousMode) });
        resetWorkspaceState(null);
        // Diagnostics are only invalidated elsewhere: their cached payloads and
        // mutation errors would otherwise keep describing the previous mode.
        queryClient.removeQueries({ queryKey: ['bridge-status'] });
        queryClient.removeQueries({ queryKey: ['health'] });
        refreshInventory.reset();
        resumeInventory.reset();
        queryClient.setQueryData<OrgSummary[]>(orgsQueryKey(result.mode), []);
        setFocusObject(null);
        if (persistPreferencesRef.current) setModePreference(requestedMode);
        setSelectedAlias(null);
        if (persistPreferencesRef.current) setSelectedOrg(null);
        // The connector exposes a different org list in each mode. Refresh it so
        // a mode switch cannot leave the UI stuck on the previous mode's orgs.
        // The new key is not observed yet, so invalidation alone cannot fetch it.
        invalidateWorkspaceState(queryClient);
        void queryClient.refetchQueries({ queryKey: orgsQueryKey(result.mode) });
        setModeError('');
        setModeNotice(requestedMode === 'demo'
          ? 'Now using demo mode — sample metadata only.'
          : hosted
            ? 'Now using live mode — reading metadata through your local SF CLI bridge.'
            : 'Now using live mode — reading metadata from your Salesforce CLI.');
      } finally {
        modePendingRef.current = false;
      }
    },
    onError: (error, requestedMode) => {
      modePendingRef.current = false;
      modeAppliedRef.current = null;
      failedModeRef.current = requestedMode;
      setModeError(`Couldn't switch to ${requestedMode} mode. ${error.message}`);
    },
  });

  const eraseLocalData = async () => {
    stopInFlightDiscovery();
    persistPreferencesRef.current = false;
    eraseInProgressRef.current = true;
    try {
      // Reset the server session first. If the connector is offline, nothing in
      // this browser has been erased yet and the user can safely retry.
      await setModeAsync('demo');
      await clearDcatCachedMetadata(queryClient);
      clearDcatLocalPreferences();
      resetNoticeDismissals();
      setHiddenAliases([]);
      theme.reset();
      modeAppliedRef.current = null;
      modePendingRef.current = false;
      setDataEpoch((value) => value + 1);
      setPreferencesEpoch((value) => value + 1);
    } catch (error) {
      // A failed erase must leave the app in its normal persistence mode.
      persistPreferencesRef.current = true;
      throw error;
    } finally {
      eraseInProgressRef.current = false;
    }
  };

  // Settings owns inline results for its data actions; remounting it from its
  // own callback would discard the result the user needs to read. Org
  // Connections owns live alias and connect results, so a mode change must
  // remount it or those strings would survive into demo mode.
  const contentKey = page === 'settings'
    ? 'settings'
    : page === 'orgs'
      ? `orgs-${mode}-${dataEpoch}`
      : `${page}-${context?.contextId ?? 'none'}-${dataEpoch}`;

  const refreshInventory = useMutation({
    mutationFn: async (target: WorkspaceContext | null) => {
      // Supersede any refresh started under a previous org or mode.
      refreshControllerRef.current?.abort();
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      refreshContextRef.current = target?.contextId ?? null;
      try {
        if (!target?.alias) throw new Error('Select an org first.');
        return await api.inventory(target.alias, { force: true, signal: controller.signal });
      } finally {
        if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      }
    },
    onSuccess: (snapshot: InventorySnapshot, target) => {
      // A late response must never replace a different org's cached snapshot.
      if (!target || target.contextId !== activeContextIdRef.current) return;
      queryClient.setQueryData<InventorySnapshot>(['inventory', target.contextId], snapshot);
    },
    onError: (error) => {
      // Cancellation is a user action, not a failure worth surfacing as an error.
      if (error instanceof ApiError && error.code === 'ABORTED') return;
    },
  });

  const resumeInventory = useMutation({
    mutationFn: async ({ target, sessionId, family }: {
      target: WorkspaceContext | null;
      sessionId: string;
      family?: ResourceFamily;
    }) => {
      resumeControllerRef.current?.abort();
      const controller = new AbortController();
      resumeControllerRef.current = controller;
      refreshContextRef.current = target?.contextId ?? null;
      try {
        if (!target?.alias) throw new Error('Select an org first.');
        return await api.inventory(target.alias, {
          sessionId,
          resume: true,
          family,
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            if (target.contextId === activeContextIdRef.current) {
              queryClient.setQueryData<InventorySnapshot>(['inventory', target.contextId], snapshot);
            }
          },
        });
      } finally {
        if (resumeControllerRef.current === controller) resumeControllerRef.current = null;
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ABORTED') return;
    },
  });

  refreshInventoryRef.current = () => refreshInventory.mutate(actionsContextRef.current);
  resumeInventoryRef.current = (family) => {
    const sessionId = actionsInventoryRef.current?.progress?.sessionId;
    if (!sessionId) return;
    resumeInventory.mutate({ target: actionsContextRef.current, sessionId, family });
  };

  const inventoryActionsValue = useMemo(() => ({
    context,
    mode,
    orgList,
    onGoToOrgs: goToOrgs,
    onToggleMode,
    isTogglingMode,
    refreshInventory: onRefreshInventory,
    cancelRefresh: onCancelRefresh,
    isRefreshingInventory: refreshInventory.isPending,
    refreshError: refreshInventory.error instanceof ApiError && refreshInventory.error.code === 'ABORTED'
      ? ''
      : refreshInventory.error?.message ?? '',
    resumeDiscovery: onResumeDiscovery,
    isResumingDiscovery: resumeInventory.isPending,
  }), [
    context,
    mode,
    orgList,
    goToOrgs,
    onToggleMode,
    isTogglingMode,
    onRefreshInventory,
    onCancelRefresh,
    refreshInventory.isPending,
    refreshInventory.error,
    onResumeDiscovery,
    resumeInventory.isPending,
  ]);

  useEffect(() => {
    const nextContextId = context?.contextId ?? null;
    if (refreshContextRef.current !== nextContextId) {
      refreshControllerRef.current?.abort();
      resumeControllerRef.current?.abort();
    }
    refreshContextRef.current = nextContextId;
  }, [context?.contextId]);

  useEffect(() => () => {
    refreshControllerRef.current?.abort();
    resumeControllerRef.current?.abort();
  }, []);

  // Feedback is transient: it confirms the switch without becoming permanent chrome.
  useEffect(() => {
    if (!modeNotice) return;
    const timer = window.setTimeout(() => setModeNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [modeNotice]);

  // The URL is the source of truth for deep links and browser history. Skip
  // links stay fragment-only so assistive navigation never changes the view.
  useEffect(() => {
    const syncPageFromUrl = () => {
      const hash = window.location.hash;
      if (hash.replace(/^#/, '').toLowerCase() === 'main-content') return;
      const nextPage = pageFromLocation(window.location);
      setPage(nextPage);
      const needsCanonicalUrl =
        window.location.pathname !== pagePath(nextPage) || (Boolean(hash) && isLegacyPageHash(hash));
      if (needsCanonicalUrl) writePagePath(nextPage, 'replace');
    };
    syncPageFromUrl();
    window.addEventListener('popstate', syncPageFromUrl);
    window.addEventListener('hashchange', syncPageFromUrl);
    return () => {
      window.removeEventListener('popstate', syncPageFromUrl);
      window.removeEventListener('hashchange', syncPageFromUrl);
    };
  }, []);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session || eraseInProgressRef.current) return;
    const storedPreference = getModePreference();
    const preferredMode = storedPreference ?? 'demo';
    if (session.mode === preferredMode) {
      if (!storedPreference && persistPreferencesRef.current) setModePreference(session.mode);
      return;
    }
    const transitionKey = `${session.mode}->${preferredMode}`;
    if (modePendingRef.current || modeAppliedRef.current === transitionKey) return;
    modeAppliedRef.current = transitionKey;
    modePendingRef.current = true;
    mutateMode(preferredMode);
    // `mutate` is stable; depending on the whole mutation object re-ran this
    // effect after every failure and created a retry loop.
  }, [sessionQuery.data, mutateMode]);

  useEffect(() => {
    // Restored orgs arrive asynchronously, and the mode needed to read them
    // comes from the session. Acting on an empty list in that gap would clear
    // the saved alias and discard the snapshot being restored.
    if (isRestoring || !sessionReady) return;
    if (selectedAlias && visibleOrgs.some((org) => org.alias === selectedAlias)) return;
    const first = visibleOrgs[0] ?? null;
    resetWorkspaceState(createWorkspaceContext(mode, first)?.contextId ?? null);
    setSelectedAlias(first?.alias ?? null);
    if (persistPreferencesRef.current) setSelectedOrg(first?.alias ?? null);
  }, [isRestoring, sessionReady, visibleOrgs, selectedAlias, mode, queryClient]);

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
    resumePreferencePersistence();
    // Read the cache directly: a just-connected org may be present before the
    // observing query has re-rendered, and inventory must start in this tick.
    const cachedOrgs = queryClient.getQueryData<OrgSummary[]>(orgsQueryKey(mode)) ?? [];
    const next = createWorkspaceContext(mode, cachedOrgs.find((org) => org.alias === alias) ?? null);
    resetWorkspaceState(next?.contextId ?? null);
    setFocusObject(null);
    setSelectedAlias(alias);
    setSelectedOrg(alias);
    navigate('dashboard');
  };

  const hideOrg = (alias: string) => {
    resumePreferencePersistence();
    const next = hiddenAliases.includes(alias) ? hiddenAliases : [...hiddenAliases, alias];
    setHiddenOrgs(next);
    setHiddenAliases(next);
    if (selectedAlias === alias) {
      resetWorkspaceState(null);
      setFocusObject(null);
      setSelectedAlias(null);
      setSelectedOrg(null);
    }
  };

  const restoreOrg = (alias: string) => {
    resumePreferencePersistence();
    const next = hiddenAliases.filter((entry) => entry !== alias);
    setHiddenOrgs(next);
    setHiddenAliases(next);
  };

  const toggleMode = () => {
    if (modePendingRef.current) return;
    resumePreferencePersistence();
    modeAppliedRef.current = null;
    modePendingRef.current = true;
    setModeError('');
    mutateMode(mode === 'demo' ? 'live' : 'demo');
  };

  const retryMode = () => {
    if (modePendingRef.current) return;
    resumePreferencePersistence();
    modePendingRef.current = true;
    setModeError('');
    mutateMode(failedModeRef.current);
  };
  toggleModeRef.current = toggleMode;
  retryModeRef.current = retryMode;

  const selectSearchResult = (result: CommandResult) => {
    if (result.kind === 'stream') {
      setFocusObject({ kind: 'stream', apiName: result.apiName });
      navigate('data-streams');
      return;
    }
    if (result.kind === 'transform') {
      setFocusObject({ kind: 'transform', apiName: result.apiName });
      navigate('data-transforms');
      return;
    }
    if (result.kind !== 'dlo' && result.kind !== 'dmo') return;
    setFocusObject({ kind: result.kind, apiName: result.apiName });
    navigate(result.kind === 'dlo' ? 'dlos' : 'dmos');
  };

  const content = (() => {
    switch (page) {
      case 'dashboard':
        return <Dashboard context={context} mode={mode} onNavigate={navigate} />;
      case 'orgs':
        return (
          <OrgConnections
            mode={mode}
            selectedAlias={selectedAlias}
            onSelect={selectOrg}
            hiddenAliases={hiddenAliases}
            onRemoveOrg={hideOrg}
            onRestoreOrg={restoreOrg}
          />
        );
      case 'settings':
        return (
          <Settings
            theme={theme}
            mode={mode}
            onClearCachedMetadata={clearCachedMetadata}
            onResetSavedLayouts={resetSavedLayouts}
            onEraseLocalData={eraseLocalData}
          />
        );
      case 'data-spaces':
        return <DataSpaces context={context} />;
      case 'dlos':
        return <DloExplorer context={context} focusObject={focusObject} onFocusHandled={() => setFocusObject(null)} onNavigate={navigate} />;
      case 'dmos':
        return <DmoExplorer context={context} focusObject={focusObject} onFocusHandled={() => setFocusObject(null)} onNavigate={navigate} />;
      case 'mappings':
        return <MappingExplorer context={context} />;
      case 'data-streams':
        return (
          <DataStreamExplorer
            context={context}
            focusObject={focusObject}
            onFocusHandled={() => setFocusObject(null)}
          />
        );
      case 'data-transforms':
        return (
          <DataTransformExplorer
            context={context}
            focusObject={focusObject}
            onFocusHandled={() => setFocusObject(null)}
          />
        );
      case 'erd':
        return <ErdExplorer context={context} onNavigate={navigate} />;
      case 'lineage':
        return <DataLineageExplorer context={context} onNavigate={navigate} />;
      case 'change-impact':
        return <ChangeImpactAnalyzer context={context} onNavigate={navigate} />;
      case 'dictionary':
        return <DataDictionary context={context} onNavigate={navigate} />;
      case 'help':
        return <HelpPage onNavigate={navigate} />;
      case 'about':
        return <AboutPage onNavigate={navigate} />;
    }
  })();

  return (
    <InventoryActionsProvider value={inventoryActionsValue}>
      <AppShell
        page={page}
        onNavigate={navigate}
        context={context}
        mode={mode}
        onToggleMode={onToggleMode}
        isTogglingMode={isTogglingMode}
        modeNotice={modeNotice}
        modeError={modeError}
        onRetryMode={onRetryMode}
        orgs={visibleOrgs}
        orgsLoading={orgsQuery.isFetching}
        selectedAlias={selectedAlias}
        onSelectOrg={selectOrg}
        onGoToOrgs={goToOrgs}
        theme={theme}
        inventory={inventoryQuery.data ?? null}
        onSelectSearchResult={selectSearchResult}
        localDataEpoch={preferencesEpoch}
      >
        {/* Explorers remount on context change to reset local filters and search.
            Org Connections keeps its two-step action state while selection moves. */}
        <div key={contentKey} className="page-enter">{content}</div>
      </AppShell>
    </InventoryActionsProvider>
  );
}
