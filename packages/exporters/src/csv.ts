import type { InventorySnapshot } from '@dcat/core';

const headers = [
  'Object type',
  'Object API name',
  'Object label',
  'Data space',
  'Field API name',
  'Field label',
  'Description',
  'Data type',
  'Primary key',
  'Nullable',
  'Source endpoint',
];

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  // Org-controlled values can be opened as spreadsheets. Neutralize formulas
  // before quoting so exports cannot execute code in Excel or Sheets.
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type CsvCell = string | number | boolean | null | undefined;

/** Serialize an arbitrary table with the same formula neutralization as inventory exports. */
export function exportCsvTable(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

export function exportInventoryCsv(inventory: InventorySnapshot): string {
  const rows: CsvCell[][] = [];

  for (const object of inventory.dlos) {
    const fields = object.fields.length > 0 ? object.fields : [null];
    for (const field of fields) {
      rows.push([
        'DLO',
        object.apiName,
        object.label ?? object.apiName,
        object.dataSpace,
        field?.apiName,
        field?.label,
        field?.description,
        field?.dataType,
        field ? (field.isPrimaryKey ? 'Yes' : 'No') : null,
        field?.isNullable === null || field?.isNullable === undefined ? null : field.isNullable ? 'Yes' : 'No',
        field?.provenance.sourceEndpoint ?? object.provenance.sourceEndpoint,
      ]);
    }
  }

  for (const object of inventory.dmos) {
    const fields = object.fields.length > 0 ? object.fields : [null];
    for (const field of fields) {
      rows.push([
        'DMO',
        object.apiName,
        object.label ?? object.apiName,
        object.dataSpace,
        field?.apiName,
        field?.label,
        field?.description,
        field?.dataType,
        field ? (field.isPrimaryKey ? 'Yes' : 'No') : null,
        field?.isNullable === null || field?.isNullable === undefined ? null : field.isNullable ? 'Yes' : 'No',
        field?.provenance.sourceEndpoint ?? object.provenance.sourceEndpoint,
      ]);
    }
  }

  return exportCsvTable(headers, rows);
}
