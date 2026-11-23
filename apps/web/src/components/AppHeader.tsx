import type { MouseEvent } from 'react';
import { NAV_GROUPS, PAGE_TITLES } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import { isHosted } from '../lib/hosted.ts';
import type { ThemeController } from '../lib/useTheme.ts';
import type { WorkspaceContext, WorkspaceMode } from '../lib/workspace.ts';
import { workspaceBadge } from '../lib/workspace.ts';
import type { OrgSummary } from '@dcat/core';
import { DcatMark } from './DcatMark.tsx';
import { Icon } from './Icon.tsx';
import { Badge, Button } from './ui/index.ts';

const shortcutLabel = /Mac|iPhone|iPad/.test(
  typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`,
) ? 'CmdK' : 'Ctrl K';

interface AppHeaderProps {
  page: Page;
  onNavigate: (page: Page) => void;
  context: WorkspaceContext | null;
  mode: WorkspaceMode;
  badge: ReturnType<typeof workspaceBadge>;
  isTogglingMode: boolean;
  onToggleMode: () => void;
  orgs: OrgSummary[];
  orgsLoading: boolean;
  selectedAlias: string | null;
  onSelectOrg: (alias: string) => void;
  onGoToOrgs: () => void;
  theme: ThemeController;
  onOpenNavigation: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
}

function OrgPicker({ orgs, loading, selectedAlias, onSelectOrg }: {
  orgs: OrgSummary[];
  loading: boolean;
  selectedAlias: string | null;
  onSelectOrg: (alias: string) => void;
}) {
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
        {orgs.length === 0 ? <option value="">{loading ? 'Checking for orgs...' : 'No orgs available'}</option> : null}
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

/**
 * The global bar answers three questions in priority order: how do I move,
 * where am I, and what can I change about this workspace. Control labels and
 * state wiring are shared with the rest of the shell, so this component owns
 * presentation only.
 */
export function AppHeader({
  page,
  onNavigate,
  context,
  mode,
  badge,
  isTogglingMode,
  onToggleMode,
  orgs,
  orgsLoading,
  selectedAlias,
  onSelectOrg,
  onGoToOrgs,
  theme,
  onOpenNavigation,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenPalette,
}: AppHeaderProps) {
  const hosted = isHosted();
  const selectedOrg = orgs.find((org) => org.alias === selectedAlias) ?? null;
  const groupLabel = NAV_GROUPS.find((group) => group.items.some((item) => item.id === page))?.label ?? 'Workspace';

  const onBrandClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate('dashboard');
  };

  return (
    <header className="app-header sticky top-0 z-30 border-b border-line bg-surface">
      <div className="app-header-inner mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <div className="app-header-lead">
          <button
            type="button"
            onClick={onOpenNavigation}
            aria-label="Open navigation"
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-soft hover:bg-surface-alt hover:text-ink lg:hidden"
          >
            <Icon name="menu" />
          </button>
          <a
            href="/"
            onClick={onBrandClick}
            aria-label="DCAT home"
            title="DCAT home"
            className="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-surface-alt lg:hidden"
          >
            <DcatMark size={32} />
          </a>
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!sidebarCollapsed}
            aria-controls="desktop-sidebar"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden size-9 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink lg:grid"
          >
            <Icon name="panelLeft" size={18} />
          </button>
          <Button
            variant="quiet"
            onClick={onOpenPalette}
            aria-label="Search metadata"
            aria-keyshortcuts="Control+K Meta+K"
            title={`Search metadata (${shortcutLabel})`}
            className="shrink-0 px-2 xl:px-3"
          >
            <Icon name="search" size={17} />
            <span className="hidden xl:inline">Search</span>
            <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint 2xl:inline">{shortcutLabel}</kbd>
          </Button>
        </div>

        <div className="app-header-identity">
          <p className="label-xs hidden sm:block">{groupLabel}</p>
          <h1 title={PAGE_TITLES[page]} className="truncate text-base leading-6 font-semibold tracking-tight text-ink 2xl:text-lg">{PAGE_TITLES[page]}</h1>
          <p className="hidden truncate text-xs leading-4 text-ink-soft sm:block">
            {context
              ? `${context.alias} · ${context.environment === 'demo' ? 'sample metadata' : selectedOrg?.connectedStatus ?? 'Status unknown'}`
              : 'No org selected'}
          </p>
        </div>

        <div className="app-header-context" role="group" aria-label="Workspace context">
          <div className="flex items-center gap-1.5">
            <div className="w-24 shrink-0 xl:w-40 2xl:w-52">
              <OrgPicker orgs={orgs} loading={orgsLoading} selectedAlias={selectedAlias} onSelectOrg={onSelectOrg} />
            </div>
            <Button
              variant="quiet"
              onClick={onGoToOrgs}
              aria-label="Open org connection details"
              className="shrink-0 px-2"
            >
              <Icon name="plug" size={17} />
              <span className="hidden xl:inline">Details</span>
            </Button>
          </div>
          <div className="flex items-center gap-1.5 border-l border-line pl-1.5">
            <Badge
              tone={badge.tone}
              dot
              title={mode === 'demo' ? 'Sample metadata only - no Salesforce org is connected.' : undefined}
            >
              {badge.label}
            </Badge>
            <Button
              variant="secondary"
              onClick={onToggleMode}
              disabled={isTogglingMode}
              icon={<Icon name={mode === 'demo' ? 'plug' : 'database'} size={15} />}
              className="shrink-0 px-2 xl:px-3"
              aria-label={`Switch to ${mode === 'demo' ? 'live' : 'demo'} mode`}
              aria-busy={isTogglingMode}
              title={mode === 'demo'
                ? hosted
                  ? 'Live mode reads metadata through your local SF CLI bridge.'
                  : 'Live mode reads metadata through your local Salesforce CLI.'
                : 'Demo mode uses sample metadata; no Salesforce org is connected.'}
            >
              <span className="hidden xl:inline">{isTogglingMode ? 'Switching...' : `Use ${mode === 'demo' ? 'live' : 'demo'}`}</span>
            </Button>
          </div>
        </div>

        <div className="app-header-utilities" role="group" aria-label="Utilities">
          <Button
            variant="quiet"
            onClick={() => onNavigate('help')}
            aria-label="Help"
            title="Help and documentation"
            className="shrink-0 px-2"
          >
            <Icon name="info" size={17} />
            <span className="hidden xl:inline">Help</span>
          </Button>
          <Button
            variant="quiet"
            onClick={theme.toggle}
            aria-label={`Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme.resolved === 'dark' ? 'light' : 'dark'} theme`}
            className="shrink-0 px-2"
          >
            <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} size={17} />
          </Button>
        </div>
      </div>
    </header>
  );
}
