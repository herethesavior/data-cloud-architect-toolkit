import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { InventorySnapshot, OrgSummary } from '@dcat/core';
import { NAV_GROUPS, pageHref } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import { buildCommandResults } from '../lib/commandSearch.ts';
import type { CommandResult } from '../lib/commandSearch.ts';
import { trapDialogFocus } from '../lib/focusTrap.ts';
import { isHosted } from '../lib/hosted.ts';
import { getSidebarCollapsed, setSidebarCollapsed } from '../lib/preferences.ts';
import { workspaceBadge } from '../lib/workspace.ts';
import type { WorkspaceContext, WorkspaceMode } from '../lib/workspace.ts';
import type { ThemeController } from '../lib/useTheme.ts';
import { AppHeader } from './AppHeader.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { DcatMark } from './DcatMark.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { MetadataResultDialog } from './MetadataResultDialog.tsx';

const pageIcons: Record<Page, IconName> = {
  dashboard: 'dashboard',
  orgs: 'plug',
  'data-spaces': 'layers',
  dlos: 'database',
  dmos: 'cube',
  mappings: 'route',
  'data-streams': 'stream',
  'data-transforms': 'sparkles',
  erd: 'graph',
  lineage: 'route',
  'change-impact': 'shield',
  dictionary: 'book',
  settings: 'settings',
  help: 'info',
  about: 'presentation',
};

interface AppShellProps {
  page: Page;
  onNavigate: (page: Page) => void;
  context: WorkspaceContext | null;
  mode: WorkspaceMode;
  onToggleMode: () => void;
  isTogglingMode: boolean;
  modeNotice: string;
  modeError: string;
  onRetryMode: () => void;
  orgs: OrgSummary[];
  orgsLoading: boolean;
  selectedAlias: string | null;
  onSelectOrg: (alias: string) => void;
  onGoToOrgs: () => void;
  theme: ThemeController;
  localDataEpoch?: number;
  inventory: InventorySnapshot | null;
  onSelectSearchResult: (result: CommandResult) => void;
  children: ReactNode;
}

interface NavigationListProps {
  page: Page;
  onNavigate: (page: Page) => void;
  label: string;
  collapsed?: boolean;
}

/** Preserve browser behavior for modified clicks while routing plain clicks. */
export function navigateFromLink(
  event: MouseEvent<HTMLAnchorElement>,
  page: Page,
  onNavigate: (page: Page) => void,
) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate(page);
}

function NavigationList({ page, onNavigate, label, collapsed = false }: NavigationListProps) {
  return (
    <nav aria-label={label} className={collapsed ? 'space-y-0' : 'space-y-6'}>
      {NAV_GROUPS.map((group, groupIndex) => (
        <div key={group.label}>
          <p className="label-xs sidebar-group-label mb-2 px-3">{group.label}</p>
          {collapsed && groupIndex > 0 ? (
            <div aria-hidden="true" className="mx-auto my-2 h-px w-8 bg-line" />
          ) : null}
          <div className="space-y-1">
            {group.items.map((item) => {
              const active = item.id === page;
              return (
                <a
                  key={item.id}
                  href={pageHref(item.id)}
                  onClick={(event) => navigateFromLink(event, item.id, onNavigate)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`nav-item ${active ? 'nav-item-active' : ''}`}
                >
                  <Icon name={pageIcons[item.id]} size={collapsed ? 20 : 18} />
                  <span className="sidebar-label">{item.label}</span>
                  {active ? (
                    <span aria-hidden="true" className="sidebar-active-dot ml-auto size-1.5 rounded-full bg-brand" />
                  ) : null}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

interface MobileNavProps {
  page: Page;
  onNavigate: (page: Page) => void;
  onClose: () => void;
}

function MobileNav({ page, onNavigate, onClose }: MobileNavProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button type="button" aria-label="Close navigation" onClick={onClose} className="overlay-backdrop absolute inset-0 bg-ink/30" />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        className="overlay-panel absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-surface shadow-popover"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-4">
          <div className="flex items-center gap-2">
            <DcatMark size={32} />
            <span className="font-semibold">DCAT</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="grid size-9 place-items-center rounded-lg text-ink-soft hover:bg-surface-alt hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <NavigationList page={page} onNavigate={onNavigate} label="Mobile navigation" />
        </div>
      </aside>
    </div>
  );
}

export function AppShell({
  page,
  onNavigate,
  context,
  mode,
  onToggleMode,
  isTogglingMode,
  modeNotice,
  modeError,
  onRetryMode,
  orgs,
  orgsLoading,
  selectedAlias,
  onSelectOrg,
  onGoToOrgs,
  theme,
  localDataEpoch = 0,
  inventory,
  onSelectSearchResult,
  children,
}: AppShellProps) {
  const hosted = isHosted();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setCollapsed] = useState(getSidebarCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [metadataResult, setMetadataResult] = useState<CommandResult | null>(null);
  // Building the index walks every object in the inventory. Do that only while
  // search is actually open; the cached snapshot is still available on open.
  const commandResults = useMemo(
    () => paletteOpen ? buildCommandResults(inventory) : [],
    [paletteOpen, inventory],
  );
  const previousDataEpochRef = useRef(localDataEpoch);
  // The session mode is the source of truth even when no org is selected. A
  // context-less demo session must never present itself as a live workspace.
  const badge = workspaceBadge(context, mode);
  const activeMode = mode;

  const navigate = (nextPage: Page) => {
    onNavigate(nextPage);
    setMenuOpen(false);
  };

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setCollapsed(next);
    setSidebarCollapsed(next);
  };

  useEffect(() => {
    if (localDataEpoch === previousDataEpochRef.current) return;
    previousDataEpochRef.current = localDataEpoch;
    setCollapsed(false);
    setSidebarCollapsed(false);
  }, [localDataEpoch]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMetadataResult(null);
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const openPalette = () => {
    setMetadataResult(null);
    setPaletteOpen(true);
  };

  const selectSearchResult = (result: CommandResult) => {
    setPaletteOpen(false);
    if (result.kind === 'dlo' || result.kind === 'dmo' || result.kind === 'stream' || result.kind === 'transform') {
      onSelectSearchResult(result);
    } else {
      setMetadataResult(result);
    }
  };

  return (
    <div className="min-h-screen lg:flex">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside
        id="desktop-sidebar"
        data-collapsed={sidebarCollapsed}
        className="sidebar hidden shrink-0 flex-col border-r border-line bg-surface lg:flex"
      >
        <a
          href={pageHref('dashboard')}
          onClick={(event) => navigateFromLink(event, 'dashboard', navigate)}
          aria-label="DCAT home"
          title="DCAT home"
          className="sidebar-header flex items-center gap-3 px-5 py-5"
        >
          <DcatMark size={40} />
          <div className="sidebar-label min-w-0">
            <p className="font-semibold tracking-tight">DCAT</p>
            <p className="truncate text-xs text-ink-soft">Data Cloud Architect Toolkit</p>
          </div>
        </a>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <NavigationList page={page} onNavigate={navigate} label="Main navigation" collapsed={sidebarCollapsed} />
        </div>
        <div className="sidebar-footer border-t border-line p-4">
          <div className="rounded-lg bg-surface-alt p-3">
            <div
              className="sidebar-footer-heading flex items-center gap-2 text-ink-soft"
              title={hosted ? 'Hosted edition - read-only metadata' : 'Local-first - read-only metadata'}
            >
              <Icon name="shield" size={16} />
              <p className="label-xs sidebar-label">{hosted ? 'Hosted edition' : 'Local-first'}</p>
              {sidebarCollapsed ? (
                <span className="sr-only">{hosted ? 'Hosted edition' : 'Local-first'}</span>
              ) : null}
            </div>
            <p className="sidebar-label mt-1.5 text-xs text-ink-soft">
              {hosted
                ? 'Read-only metadata. Typed operations go to your local SF CLI bridge.'
                : 'Read-only metadata. Credentials stay in your Salesforce CLI.'}
            </p>
          </div>
          <p className="sidebar-label mt-3 text-[11px] text-ink-faint">
            {hosted ? 'v0.1 · Hosted workbench' : 'v0.1 · Local-first workbench'}
          </p>
        </div>
      </aside>

      {menuOpen ? <MobileNav page={page} onNavigate={navigate} onClose={() => setMenuOpen(false)} /> : null}

      <div className="min-w-0 flex-1">
        <AppHeader
          page={page}
          onNavigate={onNavigate}
          context={context}
          mode={mode}
          badge={badge}
          isTogglingMode={isTogglingMode}
          onToggleMode={onToggleMode}
          orgs={orgs}
          orgsLoading={orgsLoading}
          selectedAlias={selectedAlias}
          onSelectOrg={onSelectOrg}
          onGoToOrgs={onGoToOrgs}
          theme={theme}
          onOpenNavigation={() => setMenuOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenPalette={openPalette}
        />

        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
          {modeError ? (
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-4 py-2.5 text-sm text-danger" role="alert">
              <Icon name="warning" size={16} />
              <span>{modeError}</span>
              <button
                type="button"
                onClick={onRetryMode}
                disabled={isTogglingMode}
                className="ml-auto font-semibold underline underline-offset-2 disabled:opacity-50"
              >
                Try again
              </button>
            </div>
          ) : null}
          {children}
        </main>
        {/* The live region persists so assistive tech announces transient feedback. */}
        <div className="sr-only" aria-live="polite">{modeNotice}</div>
        {modeNotice ? (
          <div className="mode-toast pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2 px-4" aria-hidden="true">
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink shadow-popover">
              <Icon name="check" size={16} className="text-success" />
              <span>{modeNotice}</span>
            </div>
          </div>
        ) : null}
        {paletteOpen ? (
          <CommandPalette
            results={commandResults}
            contextLabel={badge.label}
            mode={activeMode}
            onClose={() => setPaletteOpen(false)}
            onSelect={selectSearchResult}
            onGoToOrgs={() => navigate('orgs')}
            onToggleMode={onToggleMode}
            isTogglingMode={isTogglingMode}
          />
        ) : null}
        {metadataResult ? (
          <MetadataResultDialog result={metadataResult} onClose={() => setMetadataResult(null)} />
        ) : null}
      </div>
    </div>
  );
}
