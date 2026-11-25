import { useEffect, useRef, useState } from 'react';
import {
  CURATED_API_VERSIONS,
  RECOMMENDED_API_VERSION,
  createApiVersionStatus,
  type ApiVersionSelection,
  type ApiVersionStatus,
  type CuratedApiVersion,
} from '@dcat/core';
import { Icon } from './Icon.tsx';
import { Button, CopyButton, Panel, SectionHeading } from './ui/index.ts';

const SALESFORCE_CLI_INSTALL = 'npm install -g @salesforce/cli@latest';
const SALESFORCE_CLI_DOCS = 'https://developer.salesforce.com/docs/platform/salesforce-cli/guide/install.html';

interface CompatibilityPanelProps {
  status: ApiVersionStatus;
  cliVersion: string | null;
  demo: boolean;
  canChange: boolean;
  disabledReason: string;
  saving: boolean;
  error: string;
  notice: string;
  onSave: (selection: ApiVersionSelection) => Promise<void>;
}

function selectionLabel(status: ApiVersionStatus, demo: boolean): string {
  if (demo) return 'Demo fixture';
  if (status.selection.mode === 'recommended') return `DCAT-recommended · v${status.used ?? RECOMMENDED_API_VERSION}`;
  if (status.selection.mode === 'latest') return 'Latest available';
  return `Specific · v${status.selection.version}`;
}

/** Read-only facts first; changing the bridge-owned setting stays in a disclosure. */
export function CompatibilityPanel({
  status,
  cliVersion,
  demo,
  canChange,
  disabledReason,
  saving,
  error,
  notice,
  onSave,
}: CompatibilityPanelProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<ApiVersionSelection>(status.selection);
  const fallback = createApiVersionStatus();
  const used = demo ? '65.0' : status.used;
  const latest = demo ? null : status.latest;
  const verifiedAt = demo ? null : status.verifiedAt;
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

  const facts = [
    { label: 'Salesforce CLI version', value: cliVersion ? `v${cliVersion}` : 'Not detected' },
    { label: 'Salesforce API version', value: used ? `v${used}` : 'Not verified' },
    { label: 'Setting', value: selectionLabel(status, demo) },
    { label: 'Latest available', value: latest ? `v${latest}` : demo ? 'Not used in demo' : 'Not checked' },
    { label: 'DCAT-recommended', value: `v${fallback.recommended}` },
    { label: 'Last verified', value: verifiedAt ? new Date(verifiedAt).toLocaleString() : '—' },
  ];

  return (
    <Panel>
      <SectionHeading
        title="Compatibility"
        description="The Salesforce API version DCAT uses for live metadata, and the CLI that reads it."
      />
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.label} className="rounded-lg bg-surface-alt px-3 py-2.5">
            <dt className="label-xs">{fact.label}</dt>
            <dd className="mt-1 break-words text-ink">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {!demo && status.probeStatus && status.probeStatus !== 'available' ? (
        <p className="mt-4 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          DCAT checked the org's version list but could not read it. The selected version stays in use.
        </p>
      ) : null}

      <details ref={detailsRef} className="group mt-4 rounded-lg border border-line bg-surface-alt">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
          <span>Change API version</span>
          <Icon name="chevronDown" size={16} className="text-ink-soft transition-transform group-open:rotate-180" />
        </summary>
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
            <Button variant="quiet" onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }}>
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
      </details>

      <details className="group mt-3 rounded-lg border border-line bg-surface-alt">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm text-ink-soft [&::-webkit-details-marker]:hidden">
          <span>Advanced: update Salesforce CLI</span>
          <Icon name="chevronDown" size={15} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-line px-4 py-3 text-sm text-ink-soft">
          <p>Run this on the machine that hosts the bridge, then choose Re-check CLI.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <code className="mono min-w-0 flex-1 text-xs text-ink">{SALESFORCE_CLI_INSTALL}</code>
            <CopyButton value={SALESFORCE_CLI_INSTALL} label="Copy command" />
          </div>
          <a
            className="mt-2 inline-block text-sm font-medium text-brand underline underline-offset-2"
            href={SALESFORCE_CLI_DOCS}
            target="_blank"
            rel="noreferrer"
          >
            Salesforce CLI installation guide
          </a>
        </div>
      </details>
    </Panel>
  );
}
