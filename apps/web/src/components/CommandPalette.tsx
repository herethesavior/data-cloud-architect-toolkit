import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { filterCommandResults } from '../lib/commandSearch.ts';
import type { CommandResult } from '../lib/commandSearch.ts';
import { trapDialogFocus } from '../lib/focusTrap.ts';
import type { WorkspaceMode } from '../lib/workspace.ts';
import { Icon } from './Icon.tsx';
import { Badge, Button } from './ui/index.ts';

interface CommandPaletteProps {
  results: CommandResult[];
  contextLabel: string;
  mode: WorkspaceMode;
  onClose: () => void;
  onSelect: (result: CommandResult) => void;
  onGoToOrgs: () => void;
  onToggleMode: () => void;
  isTogglingMode: boolean;
}

/** Global search over the current, context-scoped inventory only. */
export function CommandPalette({
  results,
  contextLabel,
  mode,
  onClose,
  onSelect,
  onGoToOrgs,
  onToggleMode,
  isTogglingMode,
}: CommandPaletteProps) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const resultsId = `${baseId}-results`;
  const emptyTitleId = `${baseId}-empty-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const visible = useMemo(() => filterCommandResults(results, query), [results, query]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      trapDialogFocus(event, dialogRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (activeIndex >= visible.length) setActiveIndex(0);
  }, [activeIndex, visible.length]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, visible]);

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (visible.length === 0 ? 0 : (current + 1) % visible.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (visible.length === 0 ? 0 : (current - 1 + visible.length) % visible.length));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, visible.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = visible[activeIndex];
      if (result) onSelect(result);
    }
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
  };

  const useRecovery = (action: 'orgs' | 'demo') => {
    onClose();
    if (action === 'orgs') onGoToOrgs();
    else onToggleMode();
  };

  const noInventory = results.length === 0;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="overlay-backdrop absolute inset-0 bg-ink/30"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search metadata"
        tabIndex={-1}
        className="overlay-panel absolute top-[8vh] left-1/2 flex max-h-[84vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Icon name="search" size={18} className="text-ink-faint" />
          <label htmlFor={inputId} className="sr-only">Search inventory metadata</label>
          <input
            ref={inputRef}
            id={inputId}
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            type="text"
            role="combobox"
            autoComplete="off"
            placeholder="Search data spaces, objects, streams, mappings, transforms…"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-autocomplete="list"
            aria-activedescendant={visible.length > 0 ? `${baseId}-option-${activeIndex}` : undefined}
            className="min-w-0 flex-1 border-0 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:ring-0"
          />
          <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint sm:block">Esc</kbd>
        </div>

        <div id={resultsId} role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="px-4 py-10 text-center" aria-labelledby={emptyTitleId}>
              <span className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-surface-alt text-ink-faint">
                <Icon name="search" size={18} />
              </span>
              <h3 id={emptyTitleId} className="font-semibold text-ink">
                {noInventory ? 'No inventory available' : 'No matches in this inventory'}
              </h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
                {noInventory
                  ? 'Select an org to index metadata. In live mode you can also use demo metadata.'
                  : 'Try a different name, API name, or data space.'}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {noInventory ? (
                  <>
                    <Button variant="primary" onClick={() => useRecovery('orgs')}>Select an org</Button>
                    {mode === 'live' ? (
                      <Button variant="secondary" onClick={() => useRecovery('demo')} disabled={isTogglingMode}>Use demo mode</Button>
                    ) : null}
                  </>
                ) : (
                  <Button variant="secondary" onClick={() => { updateQuery(''); inputRef.current?.focus(); }}>
                    Clear search
                  </Button>
                )}
              </div>
            </div>
          ) : (
            visible.map((result, index) => (
              <button
                key={result.id}
                id={`${baseId}-option-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => onSelect(result)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  index === activeIndex ? 'bg-brand-soft' : 'hover:bg-surface-alt'
                }`}
              >
                <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${index === activeIndex ? 'bg-brand text-on-brand' : 'bg-surface-alt text-ink-soft'}`}>
                  <Icon name={result.icon} size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink">{result.label}</span>
                    <Badge tone="neutral">{result.typeLabel}</Badge>
                  </span>
                  <span className="mono mt-0.5 block truncate text-ink-faint">
                    {result.apiName}{result.dataSpace ? ` · ${result.dataSpace}` : ''}
                  </span>
                </span>
                <Icon name="arrowRight" size={15} className="text-ink-faint" />
              </button>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-alt px-4 py-2 text-xs text-ink-faint">
          <span className="truncate">{contextLabel} · current inventory</span>
          <span className="hidden sm:inline">↑↓ navigate · Enter open · Esc close</span>
          <span className="sm:hidden">Snapshots not available yet</span>
        </div>
      </div>
    </div>
  );
}
