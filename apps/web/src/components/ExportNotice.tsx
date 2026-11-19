import type { WorkspaceMode } from '../lib/workspace.ts';
import { useDismissibleNotice, useExportNoticeKey } from '../lib/noticeDismissal.ts';
import { NoticeDismissButton } from './NoticeDismissButton.tsx';

/** Shown immediately before user-initiated exports of Live metadata. */
export function ExportNotice({ mode }: { mode: WorkspaceMode }) {
  const { visible, dismiss } = useDismissibleNotice('export-notice', useExportNoticeKey());
  if (mode !== 'live' || !visible) return null;

  return (
    <p className="mb-4 flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-4 py-2.5 text-sm text-ink-soft" role="note">
      <span className="min-w-0 flex-1">
        This export contains metadata about your Salesforce org. Store and share it according to your organization's security policies.
      </span>
      <NoticeDismissButton label="Dismiss export notice" onClick={dismiss} />
    </p>
  );
}
