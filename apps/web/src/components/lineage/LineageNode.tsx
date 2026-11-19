import { Handle } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { lineageHandlePosition } from '../../lib/lineageGraph.ts';
import type { LineageFlowNode } from '../../lib/lineageGraph.ts';
import type { LineageNodeKind } from '@dcat/exporters';

const stageLabels: Record<LineageNodeKind, string> = {
  connector: 'SOURCE',
  stream: 'STREAM',
  dlo: 'DLO',
  transform: 'TRANSFORM',
  dmo: 'DMO',
  external: 'GAP',
};

export function LineageNodeComponent({ data, selected }: NodeProps<LineageFlowNode>) {
  const classes = [
    'lineage-node',
    `lineage-node-${data.kind}`,
    selected ? 'lineage-node-selected' : '',
    data.onPath ? 'lineage-node-on-path' : '',
    data.dimmed ? 'lineage-node-dimmed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <Handle
        id="target"
        type="target"
        position={lineageHandlePosition(data.direction, 'target')}
        className="lineage-handle"
        aria-label={`Incoming lineage for ${data.label}`}
      />
      <div className="lineage-node-header">
        <span className="lineage-kind" aria-hidden="true">{stageLabels[data.kind]}</span>
        <span className="lineage-degree" title={`${data.degree} direct link${data.degree === 1 ? '' : 's'}`}>
          {data.degree}
        </span>
      </div>
      <p className="lineage-title" title={data.label}>{data.label}</p>
      <p className="lineage-subtitle" title={data.apiName}>{data.apiName}</p>
      <p className="lineage-meta">
        {data.unresolved
          ? 'Not in this snapshot'
          : [data.status, data.dataSpace].filter(Boolean).join(' · ') || data.subtitle}
      </p>
      <Handle
        id="source"
        type="source"
        position={lineageHandlePosition(data.direction, 'source')}
        className="lineage-handle"
        aria-label={`Outgoing lineage for ${data.label}`}
      />
    </div>
  );
}
