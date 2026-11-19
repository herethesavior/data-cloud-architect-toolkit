import { describe, expect, it } from 'vitest';
import type { InventorySnapshot } from '@dcat/core';
import { demoInventory } from '@dcat/test-fixtures';
import {
  buildLineageGraph,
  buildLineageSvgLayout,
  exportLineageJson,
  exportLineageMarkdown,
  exportLineageMermaid,
  exportLineageSvg,
  filterLineageGraph,
  lineageNeighborhood,
} from './lineage.ts';
import type { LineagePalette } from './lineage.ts';

const palette: LineagePalette = {
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  ink: '#101828',
  inkSoft: '#475467',
  inkFaint: '#7b879b',
  line: '#e6ebf3',
  brand: '#2457d6',
  brandSoft: '#eef3ff',
  warning: '#9a5b00',
  success: '#087a53',
  danger: '#bd2f2f',
};

function cloneDemo(): InventorySnapshot {
  return structuredClone(demoInventory);
}

describe('lineage graph model', () => {
  it('joins all six demo metadata families into one grounded graph', () => {
    const graph = buildLineageGraph(demoInventory);
    expect(graph.org.alias).toBe('demo-uat');
    expect(graph.org.mode).toBe('demo');
    expect(graph.nodes).toHaveLength(30);
    expect(graph.edges).toHaveLength(43);
    expect(graph.gaps).toHaveLength(0);
    expect(graph.dataSpaces).toEqual(['default', 'sales_space']);

    const byKind = (kind: string) => graph.nodes.filter((node) => node.kind === kind).length;
    expect(byKind('connector')).toBe(3);
    expect(byKind('stream')).toBe(6);
    expect(byKind('dlo')).toBe(8);
    expect(byKind('transform')).toBe(5);
    expect(byKind('dmo')).toBe(8);
    expect(byKind('external')).toBe(0);

    const edgeKinds = (kind: string) => graph.edges.filter((edge) => edge.kind === kind).length;
    expect(edgeKinds('ingestion')).toBe(12);
    expect(edgeKinds('mapping')).toBe(7);
    expect(edgeKinds('transform-input')).toBe(9);
    expect(edgeKinds('transform-output')).toBe(6);
    expect(edgeKinds('relationship')).toBe(9);
    expect(graph.nodes.every((node) => node.degree > 0)).toBe(true);
  });

  it('keeps field-level mapping detail and marks DCAT-derived links', () => {
    const graph = buildLineageGraph(demoInventory);
    const mapping = graph.edges.find((edge) => edge.kind === 'mapping' && edge.label === 'OrderItem_MAP__dlm');
    expect(mapping?.confidence).toBe('source');
    expect(mapping?.source).toBe('dlo:OrderItem_DLO__dll');
    expect(mapping?.target).toBe('dmo:OrderItem_DMO__dlm');
    expect(mapping?.fieldLinks.length).toBeGreaterThan(2);
    expect(mapping?.fieldLinks[0]).toMatchObject({ sourceField: 'Id', targetField: 'Id' });
    expect(mapping?.detail).toContain('field mappings');

    const inferred = graph.edges.find((edge) => edge.id === 'relationship:order-account');
    expect(inferred?.confidence).toBe('derived');
    expect(inferred?.relationshipCertainty).toBe('inferred');
    expect(inferred?.detail).toContain('Not a source fact');
    const confirmed = graph.edges.find((edge) => edge.id === 'relationship:order-item-order');
    expect(confirmed?.confidence).toBe('source');
    expect(confirmed?.relationshipCertainty).toBe('confirmed');
  });

  it('shows unresolved references and orphan objects as gaps instead of dropping them', () => {
    const inventory = cloneDemo();
    inventory.dataStreams.push({
      apiName: 'Ghost_Stream',
      label: 'Ghost Stream',
      sourceConnector: 'Ghost Connector',
      targetDlo: 'Missing_DLO__dll',
      status: 'Active',
      refreshMetadata: null,
      provenance: demoInventory.dataStreams[0]!.provenance,
    });
    inventory.dlos.push({
      apiName: 'Unused_DLO__dll',
      label: 'Unused DLO',
      category: null,
      dataSpace: 'default',
      source: null,
      fields: [],
      provenance: demoInventory.dlos[0]!.provenance,
    });

    const graph = buildLineageGraph(inventory);
    const external = graph.nodes.find((node) => node.kind === 'external');
    expect(external?.apiName).toBe('Missing_DLO__dll');
    expect(external?.unresolved).toBe(true);
    expect(graph.edges.some((edge) => edge.confidence === 'missing' && edge.target === external?.id)).toBe(true);
    expect(graph.gaps.some((gap) => gap.kind === 'missing-reference' && gap.severity === 'warning')).toBe(true);
    expect(graph.gaps.some((gap) => gap.kind === 'orphan' && gap.label.includes('Unused DLO'))).toBe(true);
  });

  it('reports a stream with no target object', () => {
    const inventory = cloneDemo();
    inventory.dataStreams = inventory.dataStreams.filter((stream) => stream.apiName !== 'Accounts_Stream');
    const graph = buildLineageGraph(inventory);
    expect(graph.gaps.some((gap) => gap.kind === 'missing-target')).toBe(false);

    const untargeted = cloneDemo();
    untargeted.dataStreams[0]!.targetDlo = null;
    const untargetedGraph = buildLineageGraph(untargeted);
    expect(untargetedGraph.gaps.some((gap) =>
      gap.kind === 'missing-target' && gap.focusNodeId === 'stream:Accounts_Stream')).toBe(true);
  });

  it('filters by step kind, link confidence, and Data Space', () => {
    const graph = buildLineageGraph(demoInventory);
    const withoutTransforms = filterLineageGraph(graph, {
      kinds: graph.nodes.filter((node) => node.kind !== 'transform').map((node) => node.kind),
    });
    expect(withoutTransforms.nodes.some((node) => node.kind === 'transform')).toBe(false);
    expect(withoutTransforms.edges.some((edge) => edge.kind === 'transform-input')).toBe(false);

    const derivedOnly = filterLineageGraph(graph, { confidences: ['derived'] });
    expect(derivedOnly.edges.length).toBeGreaterThan(0);
    expect(derivedOnly.edges.every((edge) => edge.confidence === 'derived')).toBe(true);
    expect(derivedOnly.nodes.every((node) => node.degree > 0 || derivedOnly.edges.some((edge) =>
      edge.source === node.id || edge.target === node.id))).toBe(true);

    const sales = filterLineageGraph(graph, { dataSpace: 'sales_space' });
    const account = sales.nodes.find((node) => node.id === 'dlo:Account_DLO__dll');
    const webClick = sales.nodes.find((node) => node.id === 'dlo:WebClick_DLO__dll');
    expect(account).toBeUndefined();
    expect(webClick?.dataSpace).toBe('sales_space');
    // Connector and stream steps remain for context because they have no Data Space.
    expect(sales.nodes.some((node) => node.kind === 'connector')).toBe(true);
  });

  it('traces upstream and downstream paths from a selected step', () => {
    const graph = buildLineageGraph(demoInventory);
    const upstream = lineageNeighborhood(graph, 'dlo:Order_DLO__dll', 'upstream');
    expect(upstream.nodes.has('stream:Orders_Stream')).toBe(true);
    expect(upstream.nodes.has('connector:Salesforce CRM')).toBe(true);
    expect(upstream.nodes.has('dmo:Order_DMO__dlm')).toBe(false);
    expect(upstream.upstreamCount).toBeGreaterThan(0);
    expect(upstream.downstreamCount).toBe(0);

    const downstream = lineageNeighborhood(graph, 'dlo:Order_DLO__dll', 'downstream');
    expect(downstream.nodes.has('dmo:Order_DMO__dlm')).toBe(true);
    expect(downstream.nodes.has('transform:Enrich_Order_Items__dtm')).toBe(true);
    expect(downstream.nodes.has('stream:Orders_Stream')).toBe(false);

    const both = lineageNeighborhood(graph, 'dlo:Order_DLO__dll', 'both');
    expect(both.nodes.has('connector:Salesforce CRM')).toBe(true);
    expect(both.nodes.has('dmo:Order_DMO__dlm')).toBe(true);
    expect(both.edges.size).toBeGreaterThan(upstream.edges.size);
  });
});

describe('lineage exports', () => {
  it('lays out themed stages deterministically', () => {
    const graph = buildLineageGraph(demoInventory);
    const leftToRight = buildLineageSvgLayout(graph, 'LR');
    const again = buildLineageSvgLayout(graph, 'LR');
    expect(leftToRight.columns.map((column) => column.label)).toEqual([
      'Source systems',
      'Data Streams',
      'Data Lake Objects',
      'Data Transforms',
      'Data Model Objects',
      'Missing references',
    ]);
    expect(leftToRight.nodes).toHaveLength(30);
    expect(leftToRight.edges).toHaveLength(43);
    expect(leftToRight.nodes[0]?.x).toBe(again.nodes[0]?.x);
    expect(buildLineageSvgLayout(graph, 'TB').columns[1]!.offset).toBeGreaterThan(
      buildLineageSvgLayout(graph, 'TB').columns[0]!.offset,
    );
  });

  it('exports an accessible SVG with confidence styling and escaped text', () => {
    const inventory = cloneDemo();
    inventory.dataStreams.push({
      ...inventory.dataStreams[0]!,
      apiName: 'Amp_Stream',
      label: 'R&D & Co Stream',
      targetDlo: null,
    });
    const svg = exportLineageSvg(buildLineageGraph(inventory), palette, 'LR');
    expect(svg).toContain('<title>demo-uat — Data 360 lineage</title>');
    expect(svg).toContain('Source systems');
    expect(svg).toContain('R&amp;D &amp; Co Stream');
    expect(svg).toContain('stroke-dasharray="7 5"');
    expect(svg).toContain('stroke-dasharray="2 4"');
    expect(svg).toContain('Named in metadata');
    expect(svg).toContain('Missing reference');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('exports a portable Mermaid flowchart with grounded and derived links', () => {
    const mermaid = exportLineageMermaid(buildLineageGraph(demoInventory), 'LR');
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('accTitle: Data lineage for demo-uat');
    expect(mermaid).toContain('subgraph dlo["Data Lake Objects"]');
    expect(mermaid).toContain('-->|"ingests"|');
    expect(mermaid).toContain('-.->|"derived:');
    expect(mermaid).not.toContain('undefined');
    expect(mermaid).toMatch(/n\d+ -->\|"source system"\| n\d+/);
  });

  it('exports review-friendly Markdown with explicit certainty semantics', () => {
    const markdown = exportLineageMarkdown(buildLineageGraph(demoInventory));
    expect(markdown).toContain('# Data lineage — demo-uat');
    expect(markdown).toContain('DCAT does not infer lineage from similar names');
    expect(markdown).toContain('| Source systems | 3 |');
    expect(markdown).toContain('| Named in metadata');
    expect(markdown).toContain('not a source fact');
    expect(markdown).toContain('## Integrity gaps');
    expect(markdown).toContain('No unresolved references or unconnected objects in this view.');
  });

  it('escapes Markdown characters in gap details', () => {
    const inventory = cloneDemo();
    inventory.dataStreams[0]!.targetDlo = null;
    inventory.dataStreams[0]!.label = 'A | B';
    const markdown = exportLineageMarkdown(buildLineageGraph(inventory));
    expect(markdown).toContain('A \\| B');
    expect(markdown).toContain('| warning |');
  });

  it('exports a machine-readable graph without raw metadata payloads', () => {
    const json = exportLineageJson(buildLineageGraph(demoInventory));
    const parsed: unknown = JSON.parse(json);
    const graph = parsed as {
      org: { alias: string; mode: string };
      stages: { kind: string; label: string }[];
      nodes: Record<string, unknown>[];
      edges: unknown[];
      gaps: unknown[];
    };
    expect(graph.org).toMatchObject({ alias: 'demo-uat', mode: 'demo' });
    expect(graph.stages[0]).toEqual({ kind: 'connector', label: 'Source systems' });
    expect(graph.nodes).toHaveLength(30);
    expect(graph.nodes[0]).not.toHaveProperty('entity');
    expect(graph.edges).toHaveLength(43);
    expect(graph.gaps).toEqual([]);
  });
});
