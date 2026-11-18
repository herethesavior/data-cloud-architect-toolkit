import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { OrgSummary } from '@dcat/core';
import { NAV_GROUPS, PAGE_TITLES, pageHref } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import type { CommandResult } from '../lib/commandSearch.ts';
import { trapDialogFocus } from '../lib/focusTrap.ts';
import { isHosted } from '../lib/hosted.ts';
import { getSidebarCollapsed, setSidebarCollapsed } from '../lib/preferences.ts';
import { workspaceBadge } from '../lib/workspace.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import type { ThemeController } from '../lib/useTheme.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { DcatMark } from './DcatMark.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { MetadataResultDialog } from './MetadataResultDialog.tsx';
import { Badge, Button } from './ui/index.ts';

const shortcutLabel = /Mac|iPhone|iPad/.test(
  typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`,
) ? '⌘K' : 'Ctrl K';

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
  dictionary: 'book',
  settings: 'settings',
  help: 'info',
};

interface AppShellProps {
  page: Page;
  onNavigate: (page: Page) => void;
  context: WorkspaceContext | null;
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
  searchResults: CommandResult[];
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
function navigateFromLink(
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

interface OrgPickerProps {
  orgs: OrgSummary[];
  loading: boolean;
  selectedAlias: string | null;
  onSelectOrg: (alias: string) => void;
}

function OrgPicker({ orgs, loading, selectedAlias, onSelectOrg }: OrgPickerProps) {
  return (
    <label className="relative block">
      <span className="sr-only">Selected organization</span>
      <Icon name="database" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" size={16} />
      <select
        value={selectedAlias ?? ''}
        onChange={(event) => onSelectOrg(event.target.value)}
        className="input h-9 appearance-none py-1.5 pr-8 pl-9"
        disabled={orgs.length === 0}
        aria-busy={loading}
      >
        {orgs.length === 0 ? <option value="">{loading ? 'Checking for orgs…' : 'No orgs available'}</option> : null}
        {orgs.map((org) => (
          <option key={org.alias} value={org.alias}>
            {org.alias}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint" size={14} />
    </label>
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
  searchResults,
  onSelectSearchResult,
  children,
}: AppShellProps) {
  const hosted = isHosted();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setCollapsed] = useState(getSidebarCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [metadataResult, setMetadataResult] = useState<CommandResult | null>(null);
  const selectedOrg = orgs.find((org) => org.alias === selectedAlias) ?? null;
  const groupLabel = NAV_GROUPS.find((group) => group.items.some((item) => item.id === page))?.label ?? 'Workspace';
  const badge = workspaceBadge(context);
  const activeMode = context?.mode ?? 'live';

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
        <div className="sidebar-header flex items-center gap-3 px-5 py-5">
          <DcatMark size={40} />
          <div className="sidebar-label min-w-0">
            <p className="font-semibold tracking-tight">DCAT</p>
            <p className="truncate text-xs text-ink-soft">Data Cloud Architect Toolkit</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <NavigationList page={page} onNavigate={navigate} label="Main navigation" collapsed={sidebarCollapsed} />
        </div>
        <div className="sidebar-footer border-t border-line p-4">
          <div className="rounded-lg bg-surface-alt p-3">
            <div
              className="sidebar-footer-heading flex items-center gap-2 text-ink-soft"
              title={hosted ? 'Hosted edition — read-only metadata' : 'Local-first — read-only metadata'}
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
        <header className="sticky top-0 z-30 border-b border-line bg-surface">
          <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
            <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-label="Open navigation"
                className="grid size-9 place-items-center rounded-lg border border-line text-ink-soft hover:bg-surface-alt lg:hidden"
              >
                <Icon name="menu" />
              </button>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!sidebarCollapsed}
                aria-controls="desktop-sidebar"
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="hidden size-9 place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink lg:grid"
              >
                <Icon name="panelLeft" size={18} />
              </button>
              <Button
                variant="quiet"
                onClick={openPalette}
                aria-label="Search metadata"
                aria-keyshortcuts="Control+K Meta+K"
                title={`Search metadata (${shortcutLabel})`}
                className="px-2 sm:px-3"
              >
                <Icon name="search" size={17} />
                <span className="hidden lg:inline">Search</span>
                <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint xl:inline">{shortcutLabel}</kbd>
              </Button>
              <div className="min-w-0">
                <p className="label-xs hidden sm:block">{groupLabel}</p>
                <h1 className="truncate text-base font-semibold tracking-tight text-ink sm:text-lg">{PAGE_TITLES[page]}</h1>
                <p className="hidden truncate text-xs text-ink-soft sm:block">
                  {context
                    ? `${context.alias} · ${context.environment === 'demo' ? 'sample metadata' : selectedOrg?.connectedStatus ?? 'Status unknown'}`
                    : 'No org selected'}
                </p>
              </div>
              <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                <div className="w-full sm:w-52">
                  <OrgPicker orgs={orgs} loading={orgsLoading} selectedAlias={selectedAlias} onSelectOrg={onSelectOrg} />
                </div>
                <Button
                  variant="quiet"
                  onClick={onGoToOrgs}
                  aria-label="Open org connection details"
                  className="px-2"
                >
                  <Icon name="plug" size={17} />
                  <span className="hidden xl:inline">Details</span>
                </Button>
                <Badge
                  tone={badge.tone}
                  dot
                  title={activeMode === 'demo' ? 'Sample metadata only — no Salesforce org is connected.' : undefined}
                >
                  {badge.label}
                </Badge>
                <Button
                  variant="secondary"
                  onClick={onToggleMode}
                  disabled={isTogglingMode}
                  icon={<Icon name={activeMode === 'demo' ? 'plug' : 'database'} size={15} />}
                  className="px-2.5 sm:px-3"
                  aria-label={`Switch to ${activeMode === 'demo' ? 'live' : 'demo'} mode`}
                  aria-busy={isTogglingMode}
                  title={activeMode === 'demo'
                    ? hosted
                      ? 'Live mode reads metadata through your local SF CLI bridge.'
                      : 'Live mode reads metadata through your local Salesforce CLI.'
                    : 'Demo mode uses sample metadata; no Salesforce org is connected.'}
                >
                  <span className="hidden sm:inline">{isTogglingMode ? 'Switching…' : `Use ${activeMode === 'demo' ? 'live' : 'demo'}`}</span>
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => navigate('help')}
                  aria-label="Help"
                  title="Help and documentation"
                  className="px-2"
                >
                  <Icon name="info" size={17} />
                  <span className="hidden xl:inline">Help</span>
                </Button>
                <Button
                  variant="quiet"
                  onClick={theme.toggle}
                  aria-label={`Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`}
                  title={`Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`}
                  className="px-2"
                >
                  <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} size={17} />
                </Button>
              </div>
            </div>
          </div>
        </header>

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
            results={searchResults}
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
