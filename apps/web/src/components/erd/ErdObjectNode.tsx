import { Handle } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import {
  ERD_MAX_VISIBLE_FIELDS,
  erdHandlePosition,
  erdNodeHeight,
  erdSourceHandleId,
  erdTargetHandleId,
} from '../../lib/erdGraph.ts';
import type { ErdObjectNode, ErdObjectNodeData } from '../../lib/erdGraph.ts';

function keyLabel(data: ErdObjectNodeData, apiName: string): string | null {
  const field = data.fields.find((candidate) => candidate.apiName === apiName);
  if (!field) return null;
  if (field.isPrimaryKey && field.isForeignKey) return 'PK/FK';
  if (field.isPrimaryKey) return 'PK';
  if (field.isForeignKey) return 'FK';
  return null;
}

export function ErdObjectNodeComponent({ data, selected }: NodeProps<ErdObjectNode>) {
  const targetPosition = erdHandlePosition(data.direction, 'target');
  const sourcePosition = erdHandlePosition(data.direction, 'source');
  const visibleFields = data.fields.slice(0, ERD_MAX_VISIBLE_FIELDS);
  const hiddenFields = Math.max(0, data.fieldCount - visibleFields.length);

  const classes = [
    'erd-node',
    selected ? 'erd-node-selected' : '',
    data.dimmed ? 'erd-node-dimmed' : '',
    data.related ? 'erd-node-related' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ height: erdNodeHeight(data.fieldCount) }}>
      <Handle
        id={erdTargetHandleId()}
        type="target"
        position={targetPosition}
        className="erd-handle erd-handle-default"
        aria-label={`Incoming relationships for ${data.label}`}
      />
      <Handle
        id={erdSourceHandleId()}
        type="source"
        position={sourcePosition}
        className="erd-handle erd-handle-default"
        aria-label={`Outgoing relationships for ${data.label}`}
      />

      <div className="erd-node-header">
        <span className="erd-node-dot" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight text-ink" title={data.label}>{data.label}</p>
          <p className="mono mt-0.5 truncate text-[10px] leading-tight text-ink-faint" title={data.apiName}>{data.apiName}</p>
        </div>
        <span
          className="erd-node-count"
          title={`${data.connectionCount} relationship${data.connectionCount === 1 ? '' : 's'}`}
        >
          {data.connectionCount}
        </span>
      </div>

      <div className="erd-node-fields">
        {visibleFields.map((field) => {
          const key = keyLabel(data, field.apiName);
          return (
            <div key={field.apiName} className="erd-field-row" title={`${field.apiName} · ${field.dataType}`}>
              <Handle
                id={erdTargetHandleId(field.apiName)}
                type="target"
                position={targetPosition}
                className="erd-handle"
                aria-label={`Incoming relationships on ${field.apiName}`}
              />
              <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-soft">{field.apiName}</span>
              {key ? <span className={`erd-key erd-key-${key.replace('/', '-').toLowerCase()}`}>{key}</span> : null}
              <span className="max-w-[70px] truncate text-[9px] text-ink-faint">{field.dataType}</span>
              <Handle
                id={erdSourceHandleId(field.apiName)}
                type="source"
                position={sourcePosition}
                className="erd-handle"
                aria-label={`Outgoing relationships on ${field.apiName}`}
              />
            </div>
          );
        })}
        {hiddenFields > 0 ? (
          <div className="erd-node-more">+ {hiddenFields} more fields</div>
        ) : null}
      </div>
    </div>
  );
}
