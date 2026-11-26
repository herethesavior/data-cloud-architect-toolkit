import { useMemo, useState } from 'react';
import type { TransformVisualDefinition } from '@dcat/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel as FlowPanel,
  ReactFlow,
} from '@xyflow/react';
import type { NodeTypes } from '@xyflow/react';
import { Badge } from '../ui/index.ts';
import { buildTransformFlow } from '../../lib/transformGraph.ts';
import { TransformNodeComponent } from './TransformNode.tsx';

const nodeTypes: NodeTypes = { transformStep: TransformNodeComponent };

interface TransformDefinitionViewerProps {
  definition: TransformVisualDefinition;
}

export function TransformDefinitionViewer({ definition }: TransformDefinitionViewerProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Stable flow arrays keep React Flow from refitting the canvas when a step is selected.
  const { nodes, edges } = useMemo(() => buildTransformFlow(definition), [definition]);
  const selected = definition.nodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Read-only Salesforce canvas</Badge>
        <Badge tone="brand">{definition.nodes.length} steps</Badge>
        <Badge tone="neutral">{definition.edges.length} links</Badge>
        {definition.layout === 'generated' ? (
          <span className="text-xs text-ink-soft">Salesforce returned no coordinates, so DCAT arranged the steps.</span>
        ) : null}
        {definition.truncated ? (
          <span className="text-xs text-warning">Only the first steps are shown; raw metadata has the full definition.</span>
        ) : null}
      </div>
      <section aria-label="Data transform definition canvas" className="panel h-[360px] overflow-hidden bg-surface-alt">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
          minZoom={0.15}
          maxZoom={2}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          proOptions={{ hideAttribution: false }}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--color-line-strong)" />
          <Controls showInteractive={false} />
          <FlowPanel position="top-right" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-soft">
            Source coordinates: {definition.layout === 'source' ? 'yes' : 'generated'}
          </FlowPanel>
        </ReactFlow>
      </section>
      {selected ? (
        <div className="rounded-lg border border-line bg-surface-alt p-3">
          <p className="label-xs">Selected step</p>
          <p className="mt-1 text-sm font-semibold text-ink">{selected.label}</p>
          <p className="mt-0.5 text-xs text-ink-soft">
            {[selected.action, selected.type, selected.id].filter(Boolean).join(' · ')}
          </p>
          {selected.description ? <p className="mt-2 text-xs text-ink-soft">{selected.description}</p> : null}
          {selected.summary.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-ink-soft">
              {selected.summary.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-ink-soft">Select a step to inspect its source metadata. The canvas is read-only.</p>
      )}
    </div>
  );
}
