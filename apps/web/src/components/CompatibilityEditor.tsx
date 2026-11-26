import { useEffect, useId, useRef, useState } from 'react';
import {
  CURATED_API_VERSIONS,
  RECOMMENDED_API_VERSION,
  type ApiVersionSelection,
  type ApiVersionStatus,
  type CuratedApiVersion,
} from '@dcat/core';
import { Icon } from './Icon.tsx';
import { Button } from './ui/index.ts';

interface CompatibilityEditorProps {
  status: ApiVersionStatus;
  canChange: boolean;
  disabledReason: string;
  saving: boolean;
  error: string;
  notice: string;
  onSave: (selection: ApiVersionSelection) => Promise<void>;
}

export function compatibilitySettingLabel(status: ApiVersionStatus, demo: boolean): string {
  if (demo) return 'Demo fixture';
  if (status.selection.mode === 'recommended') return `DCAT-recommended · v${status.used ?? RECOMMENDED_API_VERSION}`;
  if (status.selection.mode === 'latest') return 'Latest available';
  return `Specific · v${status.selection.version}`;
}

/** Collapsed version editor for the combined bridge and compatibility panel. */
export function CompatibilityEditor({
  status,
  canChange,
  disabledReason,
  saving,
  error,
  notice,
  onSave,
}: CompatibilityEditorProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<ApiVersionSelection>(status.selection);
  const specificVersion = draft.mode === 'specific' ? draft.version : RECOMMENDED_API_VERSION;
  const selectedMode = status.selection.mode;
  const selectedVersion = status.selection.mode === 'specific' ? status.selection.version : null;

  // Health polls replace the status object; only a real selection change should
  // discard a draft the person is still editing.
  useEffect(() => {
    if (selectedVersion) setDraft({ mode: 'specific', version: selectedVersion });
    else if (selectedMode === 'recommended' || selectedMode === 'latest') setDraft({ mode: selectedMode });
  }, [selectedMode, selectedVersion]);

  const save = async () => {
    try {
      await onSave(draft);
    } catch {
      // The mutation owns the visible, translated error message.
    }
  };

  function collapse() {
    setExpanded(false);
    // Cancel is inside the collapsing panel; hand focus back to its trigger.
    triggerRef.current?.focus();
  }

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface-alt">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((open) => !open)}
        className="disclosure-trigger flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-ink hover:bg-surface"
      >
        <span>Change API version</span>
        <Icon name="chevronDown" size={16} className="disclosure-chevron text-ink-soft" />
      </button>
      <div id={panelId} data-open={expanded} className="disclosure-content" inert={!expanded} aria-hidden={!expanded}>
        <div>
          <div className="border-t border-line px-4 py-4">
            <p className="text-sm text-ink-soft">
              Choose a version your org supports. DCAT reloads metadata after saving.
            </p>
            {!canChange ? (
              <p className="mt-3 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
                {disabledReason}
              </p>
            ) : null}
            <fieldset className="mt-4 space-y-2" disabled={!canChange || saving}>
              <legend className="label-xs mb-2">API version</legend>
              <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm">
                <input
                  type="radio"
                  name="api-version-choice"
                  className="mt-1"
                  checked={draft.mode === 'recommended'}
                  onChange={() => setDraft({ mode: 'recommended' })}
                />
                <span>
                  <span className="font-medium text-ink">DCAT-recommended</span>
                  <span className="block text-xs text-ink-soft">Conservative choice · v{RECOMMENDED_API_VERSION}</span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm">
                <input
                  type="radio"
                  name="api-version-choice"
                  className="mt-1"
                  checked={draft.mode === 'latest'}
                  onChange={() => setDraft({ mode: 'latest' })}
                />
                <span>
                  <span className="font-medium text-ink">Latest available</span>
                  <span className="block text-xs text-ink-soft">Follow the highest version this org reports</span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm">
                <input
                  type="radio"
                  name="api-version-choice"
                  className="mt-1"
                  checked={draft.mode === 'specific'}
                  onChange={() => setDraft({ mode: 'specific', version: RECOMMENDED_API_VERSION })}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink">Specific version</span>
                  <span className="block text-xs text-ink-soft">Only versions DCAT supports</span>
                  <select
                    aria-label="Specific API version"
                    className="input mt-2 min-h-9 py-1.5 sm:w-36"
                    value={specificVersion}
                    onChange={(event) => {
                      if (draft.mode === 'specific') {
                        setDraft({ mode: 'specific', version: event.target.value as CuratedApiVersion });
                      }
                    }}
                  >
                    {CURATED_API_VERSIONS.map((version) => <option key={version} value={version}>v{version}</option>)}
                  </select>
                </span>
              </label>
            </fieldset>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={!canChange || saving}
                icon={<Icon name="refresh" size={15} />}
              >
                {saving ? 'Saving...' : 'Save & refresh'}
              </Button>
              <Button variant="quiet" onClick={collapse}>
                Cancel
              </Button>
            </div>
            {error ? (
              <p className="mt-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="mt-3 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-sm text-success" role="status">
                {notice}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
