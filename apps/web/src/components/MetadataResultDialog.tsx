import { commandResultDetails } from '../lib/commandSearch.ts';
import type { CommandResult } from '../lib/commandSearch.ts';
import { Icon } from './Icon.tsx';
import { Badge, CopyButton, DetailDrawer } from './ui/index.ts';

interface MetadataResultDialogProps {
  result: CommandResult;
  onClose: () => void;
}

/** Detail view for result types that do not have a dedicated explorer page yet. */
export function MetadataResultDialog({ result, onClose }: MetadataResultDialogProps) {
  const details = commandResultDetails(result);
  const raw = JSON.stringify(result.raw, null, 2);

  return (
    <DetailDrawer
      open
      title={result.label}
      subtitle={result.apiName}
      breadcrumbs={`Search / ${result.typeLabel}`}
      headerActions={
        <>
          <CopyButton value={result.apiName} label="Copy API name" />
          <CopyButton value={raw} label="Copy metadata JSON" icon="copy" />
        </>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand" dot>{result.typeLabel}</Badge>
          {result.dataSpace ? <Badge tone="neutral">Data space · {result.dataSpace}</Badge> : null}
        </div>

        {details.length > 0 ? (
          <dl className="grid gap-2.5 rounded-lg border border-line bg-surface-alt p-4 text-sm">
            {details.map((detail) => (
              <div key={detail.label} className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
                <dt className="text-xs font-medium text-ink-soft">{detail.label}</dt>
                <dd className="mono min-w-0 break-words text-ink">{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div>
          <p className="label-xs mb-2 flex items-center gap-1.5">
            <Icon name="lock" size={13} />
            Raw metadata · read-only
          </p>
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-alt p-3 text-xs text-ink-soft">{raw}</pre>
        </div>

        <p className="text-xs text-ink-soft">
          This record has no dedicated explorer in this build. Metadata is read from the current inventory snapshot only.
        </p>
      </div>
    </DetailDrawer>
  );
}
