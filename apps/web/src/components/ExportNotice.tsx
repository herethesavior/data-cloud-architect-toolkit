import type { WorkspaceMode } from '../lib/workspace.ts';

/** Shown immediately before user-initiated exports of Live metadata. */
export function ExportNotice({ mode }: { mode: WorkspaceMode }) {
  if (mode !== 'live') return null;
  return (
    <p className="mb-4 flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-4 py-2.5 text-sm text-ink-soft" role="note">
      This export contains metadata about your Salesforce org. Store and share it according to your organization's security policies.
    </p>
  );
}
