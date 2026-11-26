import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { TransformFlowNode } from '../../lib/transformGraph.ts';

export function TransformNodeComponent({ data, selected }: NodeProps<TransformFlowNode>) {
  const kind = data.action ?? data.type ?? 'STEP';
  return (
    <div className={`w-52 rounded-xl border bg-surface p-3 shadow-sm ${selected ? 'border-brand ring-2 ring-brand/25' : 'border-line'}`}>
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-line !bg-brand"
        aria-label={`Incoming connection for ${data.label}`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="label-xs truncate">{kind}</span>
        {typeof data.fieldCount === 'number' ? <span className="text-xs text-ink-faint">{data.fieldCount} fields</span> : null}
      </div>
      <p className="mt-1.5 break-words text-sm font-semibold text-ink" title={data.label}>{data.label}</p>
      {data.description ? <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{data.description}</p> : null}
      {data.summary.length > 0 ? (
        <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-xs text-ink-soft">
          {data.summary.map((item) => <li key={item} className="truncate" title={item}>{item}</li>)}
        </ul>
      ) : null}
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-line !bg-brand"
        aria-label={`Outgoing connection for ${data.label}`}
      />
    </div>
  );
}
