import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel as FlowPanel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { AriaLabelConfig, NodeTypes, OnSelectionChangeParams, Viewport } from '@xyflow/react';
import {
  ALL_LINEAGE_CONFIDENCES,
  ALL_LINEAGE_NODE_KINDS,
  buildLineageGraph,
  downloadTextFile,
  exportInventoryJson,
  exportLineageJson,
  exportLineageMarkdown,
  exportLineageMermaid,
  exportLineageSvg,
  filterLineageGraph,
  lineageNeighborhood,
} from '@dcat/exporters';
import type {
  LineageConfidence,
  LineageGraph,
  LineageLayoutDirection,
  LineageNode,
  LineageNodeKind,
  LineageTraceMode,
} from '@dcat/exporters';
import type { InventorySnapshot } from '@dcat/core';
import { navigateFromLink } from '../components/AppShell.tsx';
import { LineageNodeComponent } from '../components/lineage/LineageNode.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Panel, SectionHeading } from '../components/ui/index.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import {
  applyLineagePositions,
  buildLineageFlow,
  getLineagePositions,
  lineageNodeMatchesSearch,
} from '../lib/lineageGraph.ts';
import type { LineageFlowEdge, LineageFlowNode } from '../lib/lineageGraph.ts';
import {
  clearLineageViewState,
  loadLineageViewState,
  saveLineageViewState,
} from '../lib/lineagePreferences.ts';
import type { LineageViewState } from '../lib/lineagePreferences.ts';
import { PAGE_TITLES, pageHref } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import { getThemePalette } from '../lib/theme.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';

const nodeTypes: NodeTypes = { lineageStep: LineageNodeComponent };

const confidenceLabels: Record<LineageConfidence, string> = {
  source: 'Source-named',
  derived: 'DCAT-derived',
  missing: 'Missing reference',
};

const kindLabels: Record<LineageNodeKind, string> = {
  connector: 'Sources',
  stream: 'Streams',
  dlo: 'DLOs',
  transform: 'Transforms',
  dmo: 'DMOs',
  external: 'Gaps',
};

const traceLabels: { value: LineageTraceMode; label: string }[] = [
  { value: 'off', label: 'Trace off' },
  { value: 'both', label: 'Full path' },
  { value: 'upstream', label: 'Upstream' },
  { value: 'downstream', label: 'Downstream' },
];

const formatLabels = { svg: 'SVG', mermaid: 'Mermaid', json: 'Lineage JSON', inventory: 'Inventory JSON', markdown: 'Lineage Markdown' } as const;
type ExportFormat = keyof typeof formatLabels;

const ariaLabelConfig: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': 'Press Enter to inspect this step and its lineage.',
  'edge.a11yDescription.default': 'Press Enter to inspect this link.',
  'controls.ariaLabel': 'Diagram viewport controls',
  'minimap.ariaLabel': 'Diagram overview',
};

function confidenceTone(confidence: LineageConfidence): BadgeTone {
  if (confidence === 'source') return 'success';
  if (confidence === 'derived') return 'warning';
  return 'danger';
}

function kindTone(kind: LineageNodeKind): BadgeTone {
  if (kind === 'dlo') return 'success';
  if (kind === 'transform') return 'warning';
  if (kind === 'dmo') return 'brand';
  if (kind === 'external') return 'danger';
  return 'neutral';
}

function explorerFor(node: LineageNode): Page | null {
  if (node.kind === 'stream' || node.kind === 'connector') return 'data-streams';
  if (node.kind === 'dlo') return 'dlos';
  if (node.kind === 'transform') return 'data-transforms';
  if (node.kind === 'dmo') return 'dmos';
  if (node.kind === 'external') return node.expectedKind === 'dmo' ? 'dmos' : 'dlos';
  return null;
}

interface LineageViewProps {
  context: WorkspaceContext | null;
  inventory: InventorySnapshot;
  freshness: ReactNode;
  onNavigate: (page: Page) => void;
}

function DataLineageExplorerView({ context, inventory, freshness, onNavigate }: LineageViewProps) {
  const contextId = context?.contextId ?? 'none';
  const [initial] = useState(() => loadLineageViewState(contextId));
  const [kinds, setKinds] = useState<LineageNodeKind[]>(initial.kinds);
  const [confidences, setConfidences] = useState<LineageConfidence[]>(initial.confidences);
  const [dataSpace, setDataSpace] = useState<string | null>(initial.dataSpace);
  const [direction, setDirection] = useState<LineageLayoutDirection>(initial.direction);
  const [traceMode, setTraceMode] = useState<LineageTraceMode>(initial.traceMode);
  const [grid, setGrid] = useState(initial.grid);
  const [minimap, setMinimap] = useState(initial.minimap);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const canvasRef = useRef<HTMLElement | null>(null);
  const layoutKeyRef = useRef(initial.direction);
  const flow = useReactFlow<LineageFlowNode, LineageFlowEdge>();

  const fullGraph = useMemo(() => buildLineageGraph(inventory), [inventory]);
  const visibleGraph = useMemo(() => filterLineageGraph(fullGraph, { kinds, confidences, dataSpace }),
    [fullGraph, kinds, confidences, dataSpace]);
  const [initialFlow] = useState(() => buildLineageFlow(
    filterLineageGraph(fullGraph, {
      kinds: initial.kinds,
      confidences: initial.confidences,
      dataSpace: initial.dataSpace,
    }),
    initial.direction,
  ));

  const [nodes, setNodes, onNodesChange] = useNodesState(
    applyLineagePositions(initialFlow.nodes, initial.positions),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges);

  const flowBase = useMemo(() => buildLineageFlow(visibleGraph, direction), [visibleGraph, direction]);

  const preferencesRef = useRef({ kinds, confidences, dataSpace, direction, traceMode, grid, minimap });
  preferencesRef.current = { kinds, confidences, dataSpace, direction, traceMode, grid, minimap };

  useEffect(() => {
    const reapplyLayout = layoutKeyRef.current !== direction;
    layoutKeyRef.current = direction;
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return flowBase.nodes.map((node) => {
        const existing = byId.get(node.id);
        return {
          ...node,
          position: reapplyLayout || !existing ? node.position : existing.position,
          selected: existing?.selected ?? false,
        };
      });
    });
    setEdges(flowBase.edges);
  }, [flowBase, direction, setNodes, setEdges]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const persist = useCallback((overrides: Partial<LineageViewState> = {}) => {
    saveLineageViewState(contextId, {
      ...preferencesRef.current,
      positions: getLineagePositions(flow.getNodes() as LineageFlowNode[]),
      viewport: flow.getViewport(),
      ...overrides,
    });
  }, [contextId, flow]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const searchMatches = useMemo(
    () => nodes.filter((node) => lineageNodeMatchesSearch(node, search)).length,
    [nodes, search],
  );
  const trace = useMemo(
    () => selectedNodeId && traceMode !== 'off'
      ? lineageNeighborhood(visibleGraph, selectedNodeId, traceMode)
      : null,
    [selectedNodeId, traceMode, visibleGraph],
  );

  const displayNodes = useMemo<LineageFlowNode[]>(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      dimmed: (search.trim().length > 0 && !lineageNodeMatchesSearch(node, search))
        || Boolean(trace && !trace.nodes.has(node.id)),
      onPath: Boolean(trace?.nodes.has(node.id)),
    },
  })), [nodes, search, trace]);

  const displayEdges = useMemo<LineageFlowEdge[]>(() => edges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const highlighted = selectedEdgeId === edge.id
      || Boolean(trace?.edges.has(edge.id))
      || Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId));
    const dimmed = (search.trim().length > 0
      && (!source || !lineageNodeMatchesSearch(source, search))
      && (!target || !lineageNodeMatchesSearch(target, search)))
      || Boolean(trace && !trace.edges.has(edge.id));
    return {
      ...edge,
      zIndex: highlighted ? 10 : 0,
      style: {
        ...edge.style,
        opacity: dimmed ? 0.14 : 1,
        strokeWidth: highlighted ? 2.4 : 1.8,
      },
    };
  }), [edges, nodeById, search, selectedEdgeId, selectedNodeId, trace]);

  const activeConfidence: LineageConfidence | 'all' = confidences.length === ALL_LINEAGE_CONFIDENCES.length
    ? 'all'
    : confidences[0] ?? 'all';

  const focusNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    void flow.fitView({ nodes: [{ id }], padding: 0.6, maxZoom: 1.1, duration: 300 });
  }, [flow, setEdges, setNodes]);

  const focusEdge = useCallback((id: string) => {
    const edge = edges.find((candidate) => candidate.id === id);
    if (!edge) return;
    setSelectedEdgeId(id);
    setSelectedNodeId(edge.source);
    setEdges((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === id })));
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === edge.source })));
  }, [edges, setEdges, setNodes]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<LineageFlowNode, LineageFlowEdge>) => {
    if (selectedNodes[0]) setSelectedNodeId(selectedNodes[0].id);
    else if (!selectedEdges[0]) setSelectedNodeId(null);
    if (selectedEdges[0]) setSelectedEdgeId(selectedEdges[0].id);
    else if (!selectedNodes[0]) setSelectedEdgeId(null);
  }, []);

  const handleNodeDragStop = useCallback((_: unknown, __: LineageFlowNode, dragged: LineageFlowNode[]) => {
    const positions = getLineagePositions(flow.getNodes() as LineageFlowNode[]);
    for (const node of dragged) positions[node.id] = { ...node.position };
    persist({ positions });
  }, [flow, persist]);

  const handleMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
    persist({ viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } });
  }, [persist]);

  const handleConfidence = (next: LineageConfidence | 'all') => {
    const selected = next === 'all' ? [...ALL_LINEAGE_CONFIDENCES] : [next];
    setConfidences(selected);
    persist({ confidences: selected });
  };

  const toggleKind = (kind: LineageNodeKind) => {
    const next = kinds.includes(kind)
      ? kinds.filter((entry) => entry !== kind)
      : [...kinds, kind];
    if (next.length === 0) {
      setMessage('Keep at least one step type visible.');
      return;
    }
    setKinds(next);
    persist({ kinds: next });
  };

  const handleDataSpace = (value: string) => {
    const next = value.trim() ? value : null;
    setDataSpace(next);
    persist({ dataSpace: next });
  };

  const handleDirection = (next: LineageLayoutDirection) => {
    setDirection(next);
    const nextFlow = buildLineageFlow(visibleGraph, next);
    const positions = getLineagePositions(nextFlow.nodes);
    setNodes((current) => applyLineagePositions(nextFlow.nodes, positions).map((node) => ({
      ...node,
      selected: current.some((candidate) => candidate.id === node.id && candidate.selected),
    })));
    persist({ direction: next, positions });
    requestAnimationFrame(() => void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 250 }));
  };

  const handleTraceMode = (next: LineageTraceMode) => {
    setTraceMode(next);
    persist({ traceMode: next });
    if (next !== 'off' && !selectedNodeId) {
      setMessage('Select a step in the canvas to trace its path.');
    }
  };

  const handleReset = () => {
    clearLineageViewState(contextId);
    const resetGraph = filterLineageGraph(fullGraph, {});
    const resetFlow = buildLineageFlow(resetGraph, 'LR');
    setKinds([...ALL_LINEAGE_NODE_KINDS]);
    setConfidences([...ALL_LINEAGE_CONFIDENCES]);
    setDataSpace(null);
    setDirection('LR');
    setTraceMode('off');
    setGrid(true);
    setMinimap(true);
    setSearch('');
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setShowAllGaps(false);
    setNodes(resetFlow.nodes);
    setEdges(resetFlow.edges);
    layoutKeyRef.current = 'LR';
    requestAnimationFrame(() => void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 250 }));
    setMessage('Lineage view reset to the current snapshot.');
  };

  const handleZoomIn = () => void flow.zoomIn({ duration: 150 });
  const handleZoomOut = () => void flow.zoomOut({ duration: 150 });
  const handleFit = () => void flow.fitView({ padding: 0.16, maxZoom: 1.15, duration: 250 });

  const handleFullscreen = async () => {
    try {
      if (document.fullscreenElement === canvasRef.current) await document.exitFullscreen();
      else await canvasRef.current?.requestFullscreen();
      requestAnimationFrame(() => void flow.fitView({ padding: 0.12, maxZoom: 1.1, duration: 250 }));
    } catch {
      setMessage('Full screen is unavailable in this browser.');
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const match = nodes.find((node) => lineageNodeMatchesSearch(node, search));
    if (match) focusNode(match.id);
  };

  const toggleGrid = () => {
    const next = !grid;
    setGrid(next);
    persist({ grid: next });
  };

  const toggleMinimap = () => {
    const next = !minimap;
    setMinimap(next);
    persist({ minimap: next });
  };

  const download = (format: ExportFormat, contents: string, extension: string, mimeType: string) => {
    downloadTextFile(`dcat-lineage-${inventory.org.alias}.${extension}`, contents, mimeType);
    setMessage(`${formatLabels[format]} export downloaded.`);
  };

  const exportItems: ExportMenuItem[] = [
    {
      id: 'svg',
      label: 'SVG',
      description: 'Static diagram of the visible flow',
      icon: 'graph',
      onSelect: () => download('svg', exportLineageSvg(visibleGraph, getThemePalette(), direction), 'svg', 'image/svg+xml'),
    },
    {
      id: 'mermaid',
      label: 'Mermaid',
      description: 'Portable .mmd text for docs and review',
      icon: 'book',
      onSelect: () => download('mermaid', exportLineageMermaid(visibleGraph, direction), 'mmd', 'text/plain'),
    },
    {
      id: 'json',
      label: 'Lineage JSON',
      description: 'Visible steps, links, and integrity gaps',
      icon: 'layers',
      onSelect: () => download('json', exportLineageJson(visibleGraph), 'json', 'application/json'),
    },
    {
      id: 'inventory',
      label: 'Inventory JSON',
      description: 'Complete machine-readable snapshot',
      icon: 'database',
      onSelect: () => download('inventory', exportInventoryJson(inventory), 'json', 'application/json'),
    },
    {
      id: 'markdown',
      label: 'Lineage Markdown',
      description: 'Review-friendly flow documentation',
      icon: 'book',
      onSelect: () => download('markdown', exportLineageMarkdown(visibleGraph), 'md', 'text/markdown'),
    },
  ];

  const selectedGraphNode = selectedNodeId
    ? visibleGraph.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const selectedGraphEdge = selectedEdgeId
    ? visibleGraph.edges.find((edge) => edge.id === selectedEdgeId) ?? null
    : null;
  const selectedNodeFlow = selectedNodeId ? nodeById.get(selectedNodeId) : null;
  const selectedPage = selectedGraphNode ? explorerFor(selectedGraphNode) : null;
  const gaps = visibleGraph.gaps;
  const warningGaps = gaps.filter((gap) => gap.severity === 'warning').length;
  const visibleGaps = showAllGaps ? gaps : gaps.slice(0, 8);

  return (
    <>
      <ExportNotice mode={context?.mode ?? 'demo'} />
      <PageIntro
        title="Data Lineage Explorer"
        description="Trace data from source systems through streams, DLOs, mappings and transforms to the DMOs that teams consume. Links come from snapshot metadata; missing references stay visible as gaps."
        actions={
          <>
            <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-1" role="group" aria-label="Filter links by grounding">
              {([
                { value: 'all' as const, label: 'All links' },
                ...ALL_LINEAGE_CONFIDENCES.map((value) => ({ value, label: confidenceLabels[value] })),
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleConfidence(option.value)}
                  aria-pressed={activeConfidence === option.value}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    activeConfidence === option.value ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-surface-alt'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {freshness}
            <ExportMenu items={exportItems} />
          </>
        }
        meta={
          <>
            <Badge tone="brand">{visibleGraph.nodes.length} steps</Badge>
            <Badge tone="neutral">{edges.length} visible links</Badge>
            <Badge tone={warningGaps > 0 ? 'danger' : 'neutral'} dot={warningGaps > 0}>
              {gaps.length} gap{gaps.length === 1 ? '' : 's'}
            </Badge>
          </>
        }
      />

      {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <input
            aria-label="Find a step in the lineage"
            className="input pr-16"
            list="lineage-step-list"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find a step in the lineage"
            value={search}
          />
          <datalist id="lineage-step-list">
            {visibleGraph.nodes.map((node) => <option key={node.id} value={node.label} />)}
          </datalist>
          {search ? (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-ink-faint">
              {searchMatches} match{searchMatches === 1 ? '' : 'es'}
            </span>
          ) : null}
        </div>

        {fullGraph.dataSpaces.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <span>Data Space</span>
            <select
              aria-label="Filter lineage by Data Space"
              className="input w-auto py-1.5 text-xs"
              onChange={(event) => handleDataSpace(event.target.value)}
              value={dataSpace ?? ''}
            >
              <option value="">All spaces</option>
              {fullGraph.dataSpaces.map((space) => <option key={space} value={space}>{space}</option>)}
            </select>
          </label>
        ) : null}

        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <span>Arrange</span>
          <select
            aria-label="Auto-layout direction"
            className="input w-auto py-1.5 text-xs"
            onChange={(event) => handleDirection(event.target.value as LineageLayoutDirection)}
            value={direction}
          >
            <option value="LR">Left to right</option>
            <option value="TB">Top to bottom</option>
          </select>
        </label>

        <div className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label="Show or hide step types">
          {ALL_LINEAGE_NODE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`btn-quiet px-2.5 text-xs ${kinds.includes(kind) ? 'text-brand' : ''}`}
              aria-pressed={kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            >
              {kindLabels[kind]}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1" role="group" aria-label="Trace mode">
          {traceLabels.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleTraceMode(option.value)}
              aria-pressed={traceMode === option.value}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                traceMode === option.value ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-surface-alt'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-faint">
          {trace && selectedNodeId
            ? `${trace.upstreamCount} upstream · ${trace.downstreamCount} downstream steps in view`
            : 'Select a step to highlight every path into and out of it.'}
        </span>
        <div className="ml-auto inline-flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-quiet px-2.5 text-xs" onClick={() => handleDirection(direction)}>Auto layout</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" onClick={handleReset}>Reset view</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Zoom out" onClick={handleZoomOut}>Zoom out</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Zoom in" onClick={handleZoomIn}>Zoom in</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Fit diagram" onClick={handleFit}>Fit</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-pressed={grid} onClick={toggleGrid}>Grid {grid ? 'on' : 'off'}</button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-pressed={minimap} onClick={toggleMinimap}>Minimap {minimap ? 'on' : 'off'}</button>
          <button
            type="button"
            className="btn-secondary px-2.5 text-xs"
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={() => void handleFullscreen()}
          >
            {isFullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </div>

      {search ? (
        <p className="mb-2 text-xs text-ink-soft" role="status">
          {searchMatches === 0
            ? `No steps match “${search}”.`
            : `${searchMatches} matching step${searchMatches === 1 ? '' : 's'}. Press Enter to focus the first match.`}
        </p>
      ) : null}
      {fullGraph.nodes.length > 150 ? (
        <p className="mb-2 text-xs text-ink-soft">
          This snapshot has {fullGraph.nodes.length} steps. Use the Data Space or step-type filters to narrow the canvas.
        </p>
      ) : null}

      <section ref={canvasRef} aria-label="Data lineage canvas" className="panel lineage-canvas-shell relative overflow-hidden">
        <div className="lineage-stage">
          {visibleGraph.nodes.length === 0 ? (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <p className="text-sm font-medium text-ink">No lineage steps match these filters</p>
                <p className="mt-1 text-xs text-ink-soft">Reset the view to show every object in the current snapshot.</p>
                <button type="button" className="btn-secondary mt-3 px-3 text-xs" onClick={handleReset}>Reset view</button>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              defaultViewport={initial.viewport ?? undefined}
              fitView={!initial.viewport}
              fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
              minZoom={0.12}
              maxZoom={2.25}
              nodesConnectable={false}
              nodesDraggable
              nodesFocusable
              edgesFocusable
              elementsSelectable
              selectNodesOnDrag={false}
              snapToGrid
              snapGrid={[8, 8]}
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
              multiSelectionKeyCode={null}
              proOptions={{ hideAttribution: false }}
              ariaLabelConfig={ariaLabelConfig}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_, edge) => focusEdge(edge.id)}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
              onSelectionChange={handleSelectionChange}
              onNodeDragStop={handleNodeDragStop}
              onMoveEnd={handleMoveEnd}
            >
              {grid ? (
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--color-line-strong)" />
              ) : null}
              {minimap ? <MiniMap pannable zoomable className="lineage-minimap" nodeColor="var(--color-brand)" maskColor="var(--color-line)" /> : null}
              <FlowPanel position="bottom-left" className="lineage-legend">
                <span className="lineage-legend-line" aria-hidden="true" />
                <span>Named in metadata</span>
                <span className="lineage-legend-line lineage-legend-dashed" aria-hidden="true" />
                <span>Derived</span>
                <span className="lineage-legend-line lineage-legend-dotted" aria-hidden="true" />
                <span>Missing</span>
              </FlowPanel>
              {isFullscreen ? (
                <FlowPanel position="top-right" className="lineage-fullscreen-exit">
                  <button type="button" className="btn-secondary px-2.5 text-xs" onClick={() => void handleFullscreen()}>
                    Exit full screen
                  </button>
                </FlowPanel>
              ) : null}
            </ReactFlow>
          )}
        </div>
      </section>

      <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Panel className="min-w-0 overflow-hidden">
          <SectionHeading
            title="Flow links"
            description="Every link is derived from a metadata reference in this snapshot. Select one to inspect its detail."
          />
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {edges.map((edge) => (
              <button
                key={edge.id}
                type="button"
                onClick={() => focusEdge(edge.id)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selectedEdgeId === edge.id ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface-alt hover:border-brand'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={confidenceTone(edge.data?.confidence ?? 'source')} dot>
                    {confidenceLabels[edge.data?.confidence ?? 'source']}
                  </Badge>
                  <span className="text-[11px] text-ink-faint">{edge.data?.kind?.replace(/-/g, ' ')}</span>
                  {edge.data?.fieldCount ? <span className="text-[11px] text-ink-faint">{edge.data.fieldCount} fields</span> : null}
                </div>
                <p className="mono mt-1.5 truncate text-[11px] text-ink">
                  {edge.source} <span className="text-ink-faint">→</span> {edge.target}
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">Link: {edge.data?.label}</p>
              </button>
            ))}
            {edges.length === 0 ? <p className="text-sm text-ink-soft">No links match this filter.</p> : null}
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel>
            <SectionHeading
              title="Step detail"
              description={selectedGraphNode || selectedGraphEdge
                ? 'Provenance and path context for the selected step or link.'
                : 'Select a step or link in the canvas to inspect it.'}
            />
            {selectedGraphNode ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={kindTone(selectedGraphNode.kind)} dot>{kindLabels[selectedGraphNode.kind]}</Badge>
                  {selectedGraphNode.status ? <Badge tone="neutral">{selectedGraphNode.status}</Badge> : null}
                  {selectedGraphNode.unresolved ? <Badge tone="danger">Not in snapshot</Badge> : null}
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">{selectedGraphNode.label}</p>
                  <p className="mono mt-0.5 break-all text-xs text-ink-faint">{selectedGraphNode.apiName}</p>
                  <p className="mt-2 text-xs text-ink-soft">
                    {selectedGraphNode.degree} direct link{selectedGraphNode.degree === 1 ? '' : 's'}
                    {selectedGraphNode.dataSpace ? ` · ${selectedGraphNode.dataSpace}` : ''}
                  </p>
                </div>
                {selectedNodeFlow ? (
                  <p className="text-xs text-ink-soft">{selectedNodeFlow.data.subtitle}</p>
                ) : null}
                {selectedGraphNode.provenance ? (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-alt px-3 py-2 text-[11px]">
                    <dt className="text-ink-faint">Endpoint</dt>
                    <dd className="mono break-all text-ink">{selectedGraphNode.provenance.sourceEndpoint}</dd>
                    <dt className="text-ink-faint">Retrieved</dt>
                    <dd className="text-ink-soft">{selectedGraphNode.provenance.retrievedAt}</dd>
                    <dt className="text-ink-faint">Confidence</dt>
                    <dd className="text-ink-soft">{selectedGraphNode.provenance.confidence}</dd>
                  </dl>
                ) : (
                  <p className="text-xs text-ink-faint">Source systems are named by stream metadata, not a separate endpoint.</p>
                )}
                {trace ? (
                  <p className="rounded-lg border border-line px-3 py-2 text-xs text-ink-soft" role="status">
                    {trace.upstreamCount} upstream and {trace.downstreamCount} downstream steps highlighted in the visible graph.
                  </p>
                ) : null}
                {selectedPage ? (
                  <a
                    href={pageHref(selectedPage)}
                    onClick={(event) => navigateFromLink(event, selectedPage, onNavigate)}
                    className="text-xs font-semibold text-brand underline underline-offset-2"
                  >
                    Open in {PAGE_TITLES[selectedPage]} →
                  </a>
                ) : null}
              </div>
            ) : selectedGraphEdge ? (
              <div className="space-y-3">
                <Badge tone={confidenceTone(selectedGraphEdge.confidence)} dot>
                  {confidenceLabels[selectedGraphEdge.confidence]}
                </Badge>
                <div>
                  <p className="text-sm font-semibold text-ink">{selectedGraphEdge.label}</p>
                  <p className="mono mt-0.5 break-all text-[11px] text-ink-faint">
                    {selectedGraphEdge.source} → {selectedGraphEdge.target}
                  </p>
                </div>
                <p className="text-xs text-ink-soft">{selectedGraphEdge.detail}</p>
                {selectedGraphEdge.relationshipCertainty ? (
                  <p className="text-xs text-ink-soft">
                    Source certainty: <span className="font-semibold">{selectedGraphEdge.relationshipCertainty}</span>
                  </p>
                ) : null}
                {selectedGraphEdge.relationshipStatus ? (
                  <p className="text-xs text-ink-soft">
                    Source status: <span className="font-semibold">{selectedGraphEdge.relationshipStatus}</span>
                  </p>
                ) : null}
                {selectedGraphEdge.fieldLinks.length > 0 ? (
                  <div className="max-h-56 overflow-auto rounded-lg border border-line">
                    <table className="data-table" aria-label={`Field mappings for ${selectedGraphEdge.label}`}>
                      <thead><tr><th>Source field</th><th>Target field</th><th>Transform</th></tr></thead>
                      <tbody>
                        {selectedGraphEdge.fieldLinks.map((field) => (
                          <tr key={`${field.sourceField}:${field.targetField}`}>
                            <td className="mono text-ink">{field.sourceField}</td>
                            <td className="mono text-ink">{field.targetField}</td>
                            <td className="text-xs text-ink-soft">{field.transformation ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {selectedGraphEdge.provenance ? (
                  <p className="text-[11px] text-ink-faint">
                    {selectedGraphEdge.provenance.sourceEndpoint} · {selectedGraphEdge.provenance.retrievedAt}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-ink-soft">
                Click a step, tab to it and press Enter, or use the search above. Turn on Trace to highlight complete paths.
              </p>
            )}
          </Panel>

          <Panel>
            <SectionHeading
              title="Integrity gaps"
              description="Unresolved references and unconnected objects are shown here instead of being silently dropped."
            />
            <div className="space-y-2">
              {visibleGaps.map((gap) => (
                <button
                  key={gap.id}
                  type="button"
                  onClick={() => {
                    if (gap.focusNodeId) focusNode(gap.focusNodeId);
                  }}
                  className="w-full rounded-lg border border-line-strong bg-surface-alt px-3 py-2 text-left transition-colors hover:border-brand"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={gap.severity === 'warning' ? 'danger' : 'neutral'} dot>{gap.severity}</Badge>
                    <span className="text-xs font-medium text-ink">{gap.label}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-soft">{gap.detail}</p>
                </button>
              ))}
              {gaps.length === 0 ? (
                <p className="text-sm text-ink-soft">No unresolved references or unconnected objects in the visible graph.</p>
              ) : null}
              {gaps.length > 8 ? (
                <button type="button" className="btn-quiet px-2 py-1 text-xs" onClick={() => setShowAllGaps(!showAllGaps)}>
                  {showAllGaps ? 'Show fewer gaps' : `Show all ${gaps.length} gaps`}
                </button>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-ink-faint">
        Graph powered by React Flow. Layout, filters, and viewport preferences are stored only in this browser.
      </p>
    </>
  );
}

export function DataLineageExplorer({
  context,
  onNavigate,
}: {
  context: WorkspaceContext | null;
  onNavigate: (page: Page) => void;
}) {
  const query = useInventory(context);
  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => (
        <ReactFlowProvider>
          <DataLineageExplorerView
            context={context}
            inventory={inventory}
            freshness={freshness}
            onNavigate={onNavigate}
          />
        </ReactFlowProvider>
      )}
    </InventoryBoundary>
  );
}
