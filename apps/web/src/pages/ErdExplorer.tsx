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
  downloadTextFile,
  exportErdMermaid,
  exportErdSvg,
  exportInventoryJson,
  exportInventoryMarkdown,
} from '@dcat/exporters';
import type { ErdCertaintyFilter, ErdLayoutDirection } from '@dcat/exporters';
import { navigateFromLink } from '../components/AppShell.tsx';
import { ErdObjectNodeComponent } from '../components/erd/ErdObjectNode.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import type { ExportMenuItem } from '../components/ExportMenu.tsx';
import { ExportNotice } from '../components/ExportNotice.tsx';
import { InventoryBoundary } from '../components/InventoryBoundary.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { Badge, Panel, SectionHeading } from '../components/ui/index.ts';
import { pagePath } from '../navigation.ts';
import type { Page } from '../navigation.ts';
import {
  applyErdPositions,
  buildErdGraph,
  filterErdEdges,
  getErdPositions,
  nodeMatchesSearch,
  relatedNodeIds,
} from '../lib/erdGraph.ts';
import type { ErdObjectNode, ErdRelationshipEdge, ErdSortMode } from '../lib/erdGraph.ts';
import { clearErdViewState, loadErdViewState, saveErdViewState } from '../lib/erdPreferences.ts';
import type { ErdViewState } from '../lib/erdPreferences.ts';
import { getThemePalette } from '../lib/theme.ts';
import { useInventory } from '../lib/useInventory.ts';
import type { WorkspaceContext } from '../lib/workspace.ts';
import type { InventorySnapshot } from '@dcat/core';

const filters: { value: ErdCertaintyFilter; label: string }[] = [
  { value: 'all', label: 'All edges' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'inferred', label: 'Inferred' },
];

const formatLabels = { svg: 'SVG', mermaid: 'Mermaid', json: 'JSON', markdown: 'Markdown' } as const;
type ExportFormat = keyof typeof formatLabels;

const nodeTypes: NodeTypes = { erdObject: ErdObjectNodeComponent };

const ariaLabelConfig: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': 'Press Enter to inspect this object and its relationships.',
  'edge.a11yDescription.default': 'Press Enter to inspect this relationship.',
  'controls.ariaLabel': 'Diagram viewport controls',
  'minimap.ariaLabel': 'Diagram overview',
};

function badgeTone(certainty: 'confirmed' | 'inferred' | 'unknown') {
  return certainty === 'confirmed' ? 'success' : certainty === 'inferred' ? 'warning' : 'neutral';
}

interface ErdViewProps {
  context: WorkspaceContext | null;
  inventory: InventorySnapshot;
  freshness: ReactNode;
  onNavigate: (page: Page) => void;
}

function ErdExplorerView({ context, inventory, freshness, onNavigate }: ErdViewProps) {
  const contextId = context?.contextId ?? 'none';
  const [initial] = useState(() => loadErdViewState(contextId));
  const [filter, setFilter] = useState<ErdCertaintyFilter>(initial.filter);
  const [direction, setDirection] = useState<ErdLayoutDirection>(initial.direction);
  const [sortMode, setSortMode] = useState<ErdSortMode>(initial.sortMode);
  const [grid, setGrid] = useState(initial.grid);
  const [minimap, setMinimap] = useState(initial.minimap);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const canvasRef = useRef<HTMLElement | null>(null);
  const layoutKeyRef = useRef(`${initial.direction}:${initial.sortMode}`);
  const flow = useReactFlow<ErdObjectNode, ErdRelationshipEdge>();
  const [initialGraph] = useState(() => buildErdGraph(inventory, {
    direction: initial.direction,
    sortMode: initial.sortMode,
  }));

  const [nodes, setNodes, onNodesChange] = useNodesState(
    applyErdPositions(initialGraph.nodes, initial.positions),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    filterErdEdges(initialGraph.edges, initial.filter),
  );

  // The first graph seeds React Flow state, but progressive snapshots keep
  // arriving after mount. Always rebuild from the current inventory so the canvas
  // cannot fall behind exports or the rest of the inventory views.
  const graph = useMemo(
    () => buildErdGraph(inventory, { direction, sortMode }),
    [inventory, direction, sortMode],
  );

  const preferencesRef = useRef({ filter, direction, sortMode, grid, minimap });
  preferencesRef.current = { filter, direction, sortMode, grid, minimap };

  useEffect(() => {
    const layoutKey = `${direction}:${sortMode}`;
    const reapplyLayout = layoutKeyRef.current !== layoutKey;
    layoutKeyRef.current = layoutKey;

    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const existing = byId.get(node.id);
        return {
          ...node,
          position: reapplyLayout || !existing ? node.position : existing.position,
          selected: existing?.selected ?? false,
        };
      });
    });
    setEdges(filterErdEdges(graph.edges, filter));
  }, [graph, filter, direction, sortMode, setNodes, setEdges]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const persist = useCallback((overrides: Partial<ErdViewState> = {}) => {
    saveErdViewState(contextId, {
      ...preferencesRef.current,
      positions: getErdPositions(flow.getNodes() as ErdObjectNode[]),
      viewport: flow.getViewport(),
      ...overrides,
    });
  }, [contextId, flow]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const searchMatches = useMemo(
    () => nodes.filter((node) => nodeMatchesSearch(node, search)).length,
    [nodes, search],
  );

  const related = useMemo(
    () => relatedNodeIds(edges.find((edge) => edge.id === selectedEdgeId), selectedNodeId),
    [edges, selectedEdgeId, selectedNodeId],
  );

  const displayNodes = useMemo<ErdObjectNode[]>(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      dimmed: search.trim().length > 0 && !nodeMatchesSearch(node, search),
      related: related.has(node.id),
    },
  })), [nodes, related, search]);

  const displayEdges = useMemo<ErdRelationshipEdge[]>(() => edges.map((edge) => {
    const highlighted = selectedEdgeId === edge.id
      || Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId));
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const dimmed = search.trim().length > 0
      && (!sourceNode || !nodeMatchesSearch(sourceNode, search))
      && (!targetNode || !nodeMatchesSearch(targetNode, search));
    return {
      ...edge,
      zIndex: highlighted ? 10 : 0,
      style: {
        ...edge.style,
        opacity: dimmed ? 0.16 : 1,
        strokeWidth: highlighted ? 2.4 : 1.8,
      },
    };
  }), [edges, nodeById, nodes, search, selectedEdgeId, selectedNodeId]);

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

  const handleSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<ErdObjectNode, ErdRelationshipEdge>) => {
    if (selectedNodes[0]) setSelectedNodeId(selectedNodes[0].id);
    else if (!selectedEdges[0]) setSelectedNodeId(null);
    if (selectedEdges[0]) setSelectedEdgeId(selectedEdges[0].id);
    else if (!selectedNodes[0]) setSelectedEdgeId(null);
  }, []);

  const handleNodeDragStop = useCallback((_: MouseEvent | TouchEvent, __: ErdObjectNode, dragged: ErdObjectNode[]) => {
    const positions = getErdPositions(flow.getNodes() as ErdObjectNode[]);
    for (const node of dragged) positions[node.id] = { ...node.position };
    persist({ positions });
  }, [flow, persist]);

  const handleMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
    persist({ viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } });
  }, [persist]);

  const handleFilter = (next: ErdCertaintyFilter) => {
    setFilter(next);
    persist({ filter: next });
  };

  const applyLayout = useCallback((nextDirection: ErdLayoutDirection, nextSortMode: ErdSortMode) => {
    const nextGraph = buildErdGraph(inventory, { direction: nextDirection, sortMode: nextSortMode });
    const positions = getErdPositions(nextGraph.nodes);
    setNodes((current) => applyErdPositions(nextGraph.nodes, positions).map((node) => ({
      ...node,
      selected: current.some((candidate) => candidate.id === node.id && candidate.selected),
    })));
    persist({ direction: nextDirection, sortMode: nextSortMode, positions });
    requestAnimationFrame(() => void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 250 }));
  }, [flow, inventory, persist, setNodes]);

  const handleDirection = (next: ErdLayoutDirection) => {
    setDirection(next);
    applyLayout(next, sortMode);
  };

  const handleSortMode = (next: ErdSortMode) => {
    setSortMode(next);
    applyLayout(direction, next);
  };

  const handleReset = () => {
    clearErdViewState(contextId);
    const resetGraph = buildErdGraph(inventory, { direction: 'LR', sortMode: 'connected' });
    setFilter('all');
    setDirection('LR');
    setSortMode('connected');
    setGrid(true);
    setMinimap(true);
    setSearch('');
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodes(resetGraph.nodes);
    setEdges(filterErdEdges(resetGraph.edges, 'all'));
    layoutKeyRef.current = 'LR:connected';
    requestAnimationFrame(() => void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 250 }));
    setMessage('Layout and view reset to the detected relationships.');
  };

  const handleZoomIn = () => void flow.zoomIn({ duration: 150 });
  const handleZoomOut = () => void flow.zoomOut({ duration: 150 });
  const handleFit = () => void flow.fitView({ padding: 0.16, maxZoom: 1.15, duration: 250 });

  const handleFullscreen = async () => {
    try {
      if (document.fullscreenElement === canvasRef.current) {
        await document.exitFullscreen();
      } else {
        await canvasRef.current?.requestFullscreen();
      }
      requestAnimationFrame(() => void flow.fitView({ padding: 0.12, maxZoom: 1.1, duration: 250 }));
    } catch {
      setMessage('Full screen is unavailable in this browser.');
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const match = nodes.find((node) => nodeMatchesSearch(node, search));
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
    downloadTextFile(`dcat-erd-${inventory.org.alias}.${extension}`, contents, mimeType);
    setMessage(`${formatLabels[format]} export downloaded.`);
  };

  const exportItems: ExportMenuItem[] = [
    {
      id: 'svg',
      label: 'SVG',
      description: 'Static diagram in the current theme',
      icon: 'graph',
      onSelect: () => download('svg', exportErdSvg(inventory, getThemePalette(), filter), 'svg', 'image/svg+xml'),
    },
    {
      id: 'mermaid',
      label: 'Mermaid',
      description: 'Portable .mmd text for docs and review',
      icon: 'book',
      onSelect: () => download('mermaid', exportErdMermaid(inventory, filter, direction), 'mmd', 'text/plain'),
    },
    {
      id: 'json',
      label: 'JSON',
      description: 'Complete machine-readable inventory',
      icon: 'layers',
      onSelect: () => download('json', exportInventoryJson(inventory), 'json', 'application/json'),
    },
    {
      id: 'markdown',
      label: 'Markdown',
      description: 'Architecture documentation',
      icon: 'book',
      onSelect: () => download('markdown', exportInventoryMarkdown(inventory), 'md', 'text/markdown'),
    },
  ];

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : null;
  const selectedObject = selectedNodeId
    ? inventory.dmos.find((object) => object.apiName === selectedNodeId)
    : null;
  const selectedRelationships = selectedNodeId
    ? edges.filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
    : [];
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : null;

  return (
    <>
      <ExportNotice mode={context?.mode ?? 'demo'} />
      <PageIntro
        title="ERD Explorer"
        description="Explore the Data 360 model as an interactive graph. Drag objects, zoom and pan, auto-arrange the view, or focus one object's relationships."
        actions={
          <>
            <div className="inline-flex rounded-lg border border-line bg-surface p-1" role="group" aria-label="Filter relationships by certainty">
              {filters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleFilter(option.value)}
                  aria-pressed={filter === option.value}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    filter === option.value ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-surface-alt'
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
            <Badge tone="brand">{graph.nodes.length} objects</Badge>
            <Badge tone="neutral">{edges.length} visible edges</Badge>
          </>
        }
      />

      {message ? <p className="mb-4 text-xs text-ink-soft" role="status">{message}</p> : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <input
            aria-label="Find an object or field"
            className="input pr-16"
            list="erd-object-list"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find an object or field"
            value={search}
          />
          <datalist id="erd-object-list">
            {graph.nodes.map((node) => <option key={node.id} value={node.data.label} />)}
          </datalist>
          {search ? (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-ink-faint">
              {searchMatches} match{searchMatches === 1 ? '' : 'es'}
            </span>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <span>Arrange</span>
          <select
            aria-label="Auto-layout direction"
            className="input w-auto py-1.5 text-xs"
            onChange={(event) => handleDirection(event.target.value as ErdLayoutDirection)}
            value={direction}
          >
            <option value="LR">Left to right</option>
            <option value="TB">Top to bottom</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <span>Sort</span>
          <select
            aria-label="Auto-sort objects"
            className="input w-auto py-1.5 text-xs"
            onChange={(event) => handleSortMode(event.target.value as ErdSortMode)}
            value={sortMode}
          >
            <option value="connected">Most connected</option>
            <option value="alphabetical">A to Z</option>
          </select>
        </label>

        <div className="inline-flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-quiet px-2.5 text-xs" onClick={() => applyLayout(direction, sortMode)}>
            Auto layout
          </button>
          <button type="button" className="btn-quiet px-2.5 text-xs" onClick={handleReset}>
            Reset view
          </button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Zoom out" onClick={handleZoomOut}>
            Zoom out
          </button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Zoom in" onClick={handleZoomIn}>
            Zoom in
          </button>
          <button type="button" className="btn-quiet px-2.5 text-xs" aria-label="Fit diagram" onClick={handleFit}>
            Fit
          </button>
          <button
            type="button"
            className="btn-quiet px-2.5 text-xs"
            aria-pressed={grid}
            onClick={toggleGrid}
          >
            Grid {grid ? 'on' : 'off'}
          </button>
          <button
            type="button"
            className="btn-quiet px-2.5 text-xs"
            aria-pressed={minimap}
            onClick={toggleMinimap}
          >
            Minimap {minimap ? 'on' : 'off'}
          </button>
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
            ? `No objects or fields match “${search}”.`
            : `${searchMatches} matching object${searchMatches === 1 ? '' : 's'}. Press Enter to focus the first match.`}
        </p>
      ) : null}

      <section
        ref={canvasRef}
        aria-label="ERD canvas"
        className="panel erd-canvas-shell relative overflow-hidden"
      >
        <div className="erd-stage">
          {graph.nodes.length === 0 ? (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <p className="text-sm font-medium text-ink">No data model objects available</p>
                <p className="mt-1 text-xs text-ink-soft">The current inventory has no DMOs to place on the diagram.</p>
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
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1.4}
                  color="var(--color-line-strong)"
                />
              ) : null}
              {minimap ? (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor="var(--color-brand)"
                  maskColor="var(--color-line)"
                  className="erd-minimap"
                />
              ) : null}
              <FlowPanel position="bottom-left" className="erd-legend">
                <span className="erd-legend-line" aria-hidden="true" />
                <span>Confirmed</span>
                <span className="erd-legend-line erd-legend-dashed" aria-hidden="true" />
                <span>Inferred / unknown</span>
              </FlowPanel>
              {isFullscreen ? (
                <FlowPanel position="top-right" className="erd-fullscreen-exit">
                  <button
                    type="button"
                    className="btn-secondary px-2.5 text-xs"
                    onClick={() => void handleFullscreen()}
                  >
                    Exit full screen
                  </button>
                </FlowPanel>
              ) : null}
            </ReactFlow>
          )}
        </div>
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <Panel>
          <SectionHeading
            title="Relationship detail"
            description="Certainty is shown on every edge so inferred links are never mistaken for source facts."
          />
          <div className="grid gap-2 md:grid-cols-2">
            {edges.map((edge) => (
              <button
                key={edge.id}
                type="button"
                onClick={() => focusEdge(edge.id)}
                className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                  selectedEdgeId === edge.id ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface-alt hover:border-brand'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={badgeTone(edge.data?.certainty ?? 'unknown')} dot>{edge.data?.certainty ?? 'unknown'}</Badge>
                  {edge.data?.status ? (
                    <Badge tone={edge.data.status === 'ACTIVE' ? 'success' : 'neutral'} dot>{edge.data.status}</Badge>
                  ) : null}
                  {edge.data?.cardinality ? <span className="text-xs text-ink-soft">{edge.data.cardinality}</span> : null}
                </div>
                <p className="mono mt-2 text-xs text-ink">
                  {edge.source} <span className="text-ink-faint">→</span> {edge.target}
                </p>
                <p className="mt-1 text-xs text-ink-soft">
                  Join fields: <span className="mono">{edge.data?.joinField}</span>
                  {edge.data?.targetField && edge.data.targetField !== edge.data.joinField ? (
                    <><span className="text-ink-faint"> → </span><span className="mono">{edge.data.targetField}</span></>
                  ) : null}
                </p>
              </button>
            ))}
            {edges.length === 0 ? (
              <p className="text-sm text-ink-soft">No relationships match this filter.</p>
            ) : null}
          </div>
        </Panel>

        <Panel>
          <SectionHeading
            title="Object detail"
            description={selectedObject ? 'Fields and links for the focused object.' : 'Select an object in the diagram to inspect it.'}
          />
          {selectedObject && selectedNode ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-ink">{selectedNode.data.label}</p>
                <p className="mono mt-0.5 text-xs text-ink-faint">{selectedObject.apiName}</p>
                <p className="mt-2 text-xs text-ink-soft">
                  {selectedObject.fields.length} fields · {selectedRelationships.length} relationships
                </p>
              </div>
              <div className="max-h-64 overflow-auto rounded-lg border border-line">
                <table className="data-table" aria-label={`Fields for ${selectedNode.data.label}`}>
                  <thead>
                    <tr><th>Field</th><th>Type</th><th>Key</th></tr>
                  </thead>
                  <tbody>
                    {selectedNode.data.fields.map((field) => (
                      <tr key={field.apiName}>
                        <td className="mono text-ink">{field.apiName}</td>
                        <td className="text-xs text-ink-soft">{field.dataType}</td>
                        <td className="text-xs text-ink-soft">
                          {[
                            field.isPrimaryKey ? 'PK' : '',
                            field.isForeignKey ? 'FK' : '',
                          ].filter(Boolean).join(' / ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selectedEdge ? (() => {
                const href = `${pagePath('change-impact')}?target=${encodeURIComponent(`relationship:${selectedEdge.id}`)}`;
                return (
                  <div className="rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs text-ink-soft">
                    <p>
                      Selected edge: <span className="mono">{selectedEdge.data?.joinField}</span>
                      {' · '}{selectedEdge.data?.certainty}
                      {selectedEdge.data?.status ? ` · ${selectedEdge.data.status}` : ''}
                    </p>
                    <a
                      href={href}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                        event.preventDefault();
                        window.history.replaceState(null, '', href);
                        onNavigate('change-impact');
                      }}
                      className="mt-2 inline-block font-semibold text-brand underline underline-offset-2"
                    >
                      Analyze impact
                    </a>
                  </div>
                );
              })() : null}
            </div>
          ) : (
            <p className="text-sm text-ink-soft">
              Click a node, tab to it and press Enter, or use the object search above.
            </p>
          )}
        </Panel>
      </div>

      <p className="mt-3 text-[11px] text-ink-faint">
        Graph powered by React Flow. Layout and viewport preferences are stored only in this browser.
      </p>
    </>
  );
}

export function ErdExplorer({ context, onNavigate }: { context: WorkspaceContext | null; onNavigate: (page: Page) => void }) {
  const query = useInventory(context);
  return (
    <InventoryBoundary query={query} context={context}>
      {(inventory, freshness) => (
        <ReactFlowProvider>
          <ErdExplorerView context={context} inventory={inventory} freshness={freshness} onNavigate={onNavigate} />
        </ReactFlowProvider>
      )}
    </InventoryBoundary>
  );
}
