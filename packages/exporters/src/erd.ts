import type { InventorySnapshot } from '@dcat/core';

export type ErdCertaintyFilter = 'all' | 'confirmed' | 'inferred';

export interface ErdNodeLayout {
  id: string;
  label: string;
  apiName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldCount: number;
}

export interface ErdEdgeLayout {
  id: string;
  source: string;
  target: string;
  label: string;
  cardinality: string;
  certainty: 'confirmed' | 'inferred' | 'unknown';
  path: string;
  labelX: number;
  labelY: number;
}

export interface ErdLayout {
  width: number;
  height: number;
  nodes: ErdNodeLayout[];
  edges: ErdEdgeLayout[];
}

export interface ErdPalette {
  surface: string;
  surfaceAlt: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  line: string;
  brand: string;
  brandSoft: string;
  warning: string;
  success: string;
}

const nodeWidth = 220;
const nodeHeight = 84;
const columns = 3;
const columnGap = 80;
const rowGap = 66;
const originX = 60;
const originY = 60;

export function buildErdLayout(inventory: InventorySnapshot): ErdLayout {
  const rows = Math.max(1, Math.ceil(inventory.dmos.length / columns));
  const width = originX * 2 + columns * nodeWidth + (columns - 1) * columnGap;
  const height = Math.max(400, originY * 2 + rows * nodeHeight + (rows - 1) * rowGap + 40);

  const nodes = inventory.dmos.map((object, index) => ({
    id: object.apiName,
    label: object.label ?? object.apiName,
    apiName: object.apiName,
    x: originX + (index % columns) * (nodeWidth + columnGap),
    y: originY + Math.floor(index / columns) * (nodeHeight + rowGap),
    width: nodeWidth,
    height: nodeHeight,
    fieldCount: object.fields.length,
  }));

  const byApiName = new Map(nodes.map((node) => [node.id, node]));
  const edges: ErdEdgeLayout[] = [];
  const placedLabels: { x: number; y: number; width: number; height: number }[] = [];

  const collides = (
    box: { x: number; y: number; width: number; height: number },
    other: { x: number; y: number; width: number; height: number },
  ) => box.x < other.x + other.width && box.x + box.width > other.x
    && box.y < other.y + other.height && box.y + box.height > other.y;

  const placeLabel = (label: string, x: number, y: number) => {
    const width = Math.max(28, label.length * 6);
    const candidates = [y, y - 24, y + 24, y - 48, y + 48, y - 72, y + 72];
    for (const candidate of candidates) {
      const box = { x: x - width / 2, y: candidate - 12, width, height: 22 };
      if (nodes.some((node) => collides(box, node))) continue;
      if (placedLabels.some((placed) => collides(box, placed))) continue;
      placedLabels.push(box);
      return candidate;
    }
    return y;
  };

  for (const relationship of inventory.relationships) {
    const source = byApiName.get(relationship.source);
    const target = byApiName.get(relationship.target);
    if (!source || !target) continue;

    const label = relationship.label ?? relationship.certainty;
    let path: string;
    let labelX: number;
    let labelY: number;

    if (Math.abs(source.y - target.y) < 1) {
      const forward = target.x >= source.x;
      const x1 = forward ? source.x + source.width : source.x;
      const x2 = forward ? target.x : target.x + target.width;
      const y1 = source.y + source.height / 2;
      const y2 = target.y + target.height / 2;
      const bend = forward ? 52 : -52;
      path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = placeLabel(label, labelX, (y1 + y2) / 2 - 10);
    } else if (Math.abs(source.x - target.x) < 1) {
      const downward = target.y > source.y;
      const x1 = source.x + source.width / 2;
      const y1 = downward ? source.y + source.height : source.y;
      const x2 = target.x + target.width / 2;
      const y2 = downward ? target.y : target.y + target.height;
      const bend = downward ? 40 : -40;
      path = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = placeLabel(label, labelX, (y1 + y2) / 2);
    } else {
      const upward = target.y < source.y;
      const x1 = source.x + source.width / 2;
      const y1 = upward ? source.y : source.y + source.height;
      const x2 = target.x + target.width / 2;
      const y2 = upward ? target.y + target.height : target.y;
      const laneY = upward
        ? (source.y + target.y + target.height) / 2
        : (source.y + source.height + target.y) / 2;
      path = `M ${x1} ${y1} C ${x1} ${laneY}, ${x2} ${laneY}, ${x2} ${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = placeLabel(label, labelX, laneY);
    }

    edges.push({
      id: relationship.id,
      source: relationship.source,
      target: relationship.target,
      label,
      cardinality: relationship.cardinality ?? '',
      certainty: relationship.certainty,
      path,
      labelX,
      labelY,
    });
  }

  return { width, height, nodes, edges };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function exportErdSvg(
  inventory: InventorySnapshot,
  palette: ErdPalette,
  filter: ErdCertaintyFilter = 'all',
): string {
  const layout = buildErdLayout(inventory);
  const edges = layout.edges.filter((edge) =>
    filter === 'all'
      || (filter === 'confirmed' && edge.certainty === 'confirmed')
      || (filter === 'inferred' && edge.certainty === 'inferred'),
  );

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img">`,
    `<title>${escapeXml(inventory.org.alias)} — Data 360 entity relationships</title>`,
    '<style>text { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }</style>',
    `<rect width="100%" height="100%" fill="${escapeXml(palette.surface)}"/>`,
    '<defs>',
    `<marker id="dcat-arrow-confirmed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(palette.brand)}"/></marker>`,
    `<marker id="dcat-arrow-inferred" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(palette.warning)}"/></marker>`,
    '</defs>',
  ];

  for (const edge of edges) {
    const confirmed = edge.certainty === 'confirmed';
    const stroke = confirmed ? palette.brand : palette.warning;
    const marker = confirmed ? 'dcat-arrow-confirmed' : 'dcat-arrow-inferred';
    const dash = confirmed ? '' : ' stroke-dasharray="6 5"';
    lines.push(
      `<path d="${edge.path}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="2"${dash} marker-end="url(#${marker})"/>`,
      `<text x="${edge.labelX}" y="${edge.labelY}" text-anchor="middle" font-size="11" fill="${escapeXml(palette.inkSoft)}">${escapeXml(edge.label)}</text>`,
    );
  }

  for (const node of layout.nodes) {
    lines.push(
      `<g>`,
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${escapeXml(palette.surface)}" stroke="${escapeXml(palette.line)}"/>`,
      `<rect x="${node.x}" y="${node.y}" width="4" height="${node.height}" rx="2" fill="${escapeXml(palette.brand)}"/>`,
      `<text x="${node.x + 16}" y="${node.y + 28}" font-size="13" font-weight="600" fill="${escapeXml(palette.ink)}">${escapeXml(node.label)}</text>`,
      `<text x="${node.x + 16}" y="${node.y + 46}" font-size="10" fill="${escapeXml(palette.inkFaint)}">${escapeXml(node.apiName)}</text>`,
      `<text x="${node.x + 16}" y="${node.y + 68}" font-size="10" fill="${escapeXml(palette.inkSoft)}">${node.fieldCount} fields</text>`,
      '</g>',
    );
  }

  const legendY = layout.height - 24;
  lines.push(
    `<line x1="${originX}" y1="${legendY - 4}" x2="${originX + 32}" y2="${legendY - 4}" stroke="${escapeXml(palette.brand)}" stroke-width="2"/>`,
    `<text x="${originX + 40}" y="${legendY}" font-size="11" fill="${escapeXml(palette.inkSoft)}">Confirmed</text>`,
    `<line x1="${originX + 140}" y1="${legendY - 4}" x2="${originX + 172}" y2="${legendY - 4}" stroke="${escapeXml(palette.warning)}" stroke-width="2" stroke-dasharray="6 5"/>`,
    `<text x="${originX + 180}" y="${legendY}" font-size="11" fill="${escapeXml(palette.inkSoft)}">Inferred</text>`,
    '</svg>',
  );

  return `${lines.join('\n')}\n`;
}
