import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import {
  buildErdLayout,
  exportErdMermaid,
  exportErdSvg,
  exportInventoryCsv,
  exportInventoryMarkdown,
} from './index.ts';

const palette = {
  surface: 'surface',
  surfaceAlt: 'surfaceAlt',
  ink: 'ink',
  inkSoft: 'inkSoft',
  inkFaint: 'inkFaint',
  line: 'line',
  brand: 'brand',
  brandSoft: 'brandSoft',
  warning: 'warning',
  success: 'success',
};

describe('inventory exporters', () => {
  it('writes dictionary rows for both object families', () => {
    const csv = exportInventoryCsv(demoInventory);
    expect(csv).toContain('Object type,Object API name');
    expect(csv).toContain('DLO,Account_DLO__dll');
    expect(csv).toContain('DMO,Account_DMO__dlm');
  });

  it('escapes commas and quotes in CSV values', () => {
    const field = demoInventory.dlos[0]!.fields[0]!;
    const inventory = {
      ...demoInventory,
      dlos: [{ ...demoInventory.dlos[0]!, fields: [{ ...field, description: 'Has, comma and "quote"' }] }],
    };
    expect(exportInventoryCsv(inventory)).toContain('"Has, comma and ""quote"""');
  });

  it('neutralizes spreadsheet formulas in exported CSV values', () => {
    const field = demoInventory.dlos[0]!.fields[0]!;
    const inventory = {
      ...demoInventory,
      dlos: [{ ...demoInventory.dlos[0]!, fields: [{ ...field, description: '=HYPERLINK("http://evil","click")' }] }],
    };
    expect(exportInventoryCsv(inventory)).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
  });

  it('writes a readable markdown inventory', () => {
    const markdown = exportInventoryMarkdown(demoInventory);
    expect(markdown).toContain('# demo-uat — Data 360 inventory');
    expect(markdown).toContain('## Data Spaces');
    expect(markdown).toContain('Account_DMO__dlm');
    expect(markdown).toContain('Review before sharing');
  });

  it('lays out only relationships whose objects exist', () => {
    const layout = buildErdLayout(demoInventory);
    expect(layout.nodes).toHaveLength(demoInventory.dmos.length);
    expect(layout.nodes).toHaveLength(8);
    expect(layout.edges).toHaveLength(demoInventory.relationships.length);
    expect(layout.edges).toHaveLength(9);
  });

  it('keeps demo edge labels clear of object boxes', () => {
    const layout = buildErdLayout(demoInventory);
    const overlaps = layout.edges.filter((edge) => {
      const width = Math.max(28, edge.label.length * 6);
      const box = {
        x: edge.labelX - width / 2,
        y: edge.labelY - 12,
        width,
        height: 22,
      };
      return layout.nodes.some((node) =>
        box.x < node.x + node.width && box.x + box.width > node.x
        && box.y < node.y + node.height && box.y + box.height > node.y);
    });

    expect(overlaps.map((edge) => edge.id)).toEqual([]);
  });

  it('exports an ERD with certainty encoded in the stroke', () => {
    const svg = exportErdSvg(demoInventory, palette);
    expect(svg).toContain('Account_DMO__dlm');
    expect(svg).toContain('stroke-dasharray="6 5"');
    expect(svg).toContain('Confirmed');
  });

  it('can export only confirmed relationships', () => {
    const svg = exportErdSvg(demoInventory, palette, 'confirmed');
    expect(svg).toContain('Account Contact');
    expect(svg).not.toContain('>ContactId<');
    expect(svg).not.toContain('>AccountId<');
    expect(svg.match(/stroke-dasharray="6 5"/g)).toHaveLength(1);
  });

  it('writes a portable Mermaid ER definition with accessible metadata', () => {
    const mermaid = exportErdMermaid(demoInventory);
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('accTitle: Data 360 entity relationships for demo-uat');
    expect(mermaid).toContain('accDescr: 8 data model objects and 9 relationships.');
    expect(mermaid).toContain('direction LR');
    expect(mermaid).toContain('Account_DMO__dlm["Account DMO"]');
    expect(mermaid).toContain('String Id PK');
    expect(mermaid).toContain('String PrimaryCampaignId FK');
    expect(mermaid).toContain('Contact_DMO__dlm }o--|| Account_DMO__dlm : "Account Contact"');
  });

  it('keeps Mermaid certainty and filtering explicit', () => {
    const confirmed = exportErdMermaid(demoInventory, 'confirmed');
    expect(confirmed).toContain('3 source-confirmed');
    expect(confirmed).not.toContain('(inferred)');
    expect(confirmed).not.toContain('String AccountId FK');

    const inferred = exportErdMermaid(demoInventory, 'inferred');
    expect(inferred).toContain('6 inferred or unknown');
    expect(inferred).toContain('(inferred)');
    expect(inferred).toContain('..||');
  });
});
