import type { InventorySnapshot } from '@dcat/core';

function mdCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const divider = headers.map(() => '---').join(' | ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${divider} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`),
  ].join('\n');
}

export function exportInventoryMarkdown(inventory: InventorySnapshot): string {
  const sections: string[] = [
    `# ${inventory.org.alias} — Data 360 inventory`,
    '',
    `> ${inventory.mode === 'demo' ? 'Demo fixture' : 'Live metadata'} · API version ${inventory.apiVersion ?? 'unknown'} · Generated ${inventory.generatedAt}`,
    '',
    '## Summary',
    '',
    mdTable(
      ['Family', 'Count'],
      [
        ['Data Spaces', inventory.dataSpaces.length],
        ['Data Lake Objects', inventory.dlos.length],
        ['Data Model Objects', inventory.dmos.length],
        ['Mappings', inventory.mappings.length],
        ['Data Streams', inventory.dataStreams.length],
        ['Transforms', inventory.dataTransforms.length],
        ['Relationships', inventory.relationships.length],
      ],
    ),
    '',
    '## Data Spaces',
    '',
    mdTable(
      ['API name', 'Label', 'Default', 'Description'],
      inventory.dataSpaces.map((space) => [space.apiName, space.label, space.isDefault ? 'Yes' : 'No', space.description]),
    ),
    '',
    '## Data Lake Objects',
    '',
    mdTable(
      ['API name', 'Label', 'Data space', 'Fields'],
      inventory.dlos.map((object) => [object.apiName, object.label, object.dataSpace, object.fields.length]),
    ),
    '',
    '## Data Model Objects',
    '',
    mdTable(
      ['API name', 'Label', 'Data space', 'Custom', 'Fields'],
      inventory.dmos.map((object) => [object.apiName, object.label, object.dataSpace, object.isCustom ? 'Yes' : 'No', object.fields.length]),
    ),
    '',
    '## Mappings',
    '',
    mdTable(
      ['Name', 'Source', 'Target', 'Field mappings'],
      inventory.mappings.map((mapping) => [
        mapping.apiName,
        mapping.sourceObject,
        mapping.targetObject,
        mapping.fieldMappings.length,
      ]),
    ),
    '',
    '## Field reference',
    '',
    mdTable(
      ['Object', 'Type', 'Field', 'Data type', 'Primary key'],
      [
        ...inventory.dlos.flatMap((object) =>
          object.fields.map((field) => [object.apiName, 'DLO', field.apiName, field.dataType, field.isPrimaryKey ? 'Yes' : 'No']),
        ),
        ...inventory.dmos.flatMap((object) =>
          object.fields.map((field) => [object.apiName, 'DMO', field.apiName, field.dataType, field.isPrimaryKey ? 'Yes' : 'No']),
        ),
      ],
    ),
    '',
    '## Relationships',
    '',
    mdTable(
      ['Source', 'Target', 'Field', 'Cardinality', 'Certainty'],
      inventory.relationships.map((relationship) => [
        relationship.source,
        relationship.target,
        relationship.label,
        relationship.cardinality,
        relationship.certainty,
      ]),
    ),
    '',
    '## Retrieval notes',
    '',
    mdTable(
      ['Family', 'Status', 'Items', 'Message'],
      inventory.capabilities.map((capability) => [
        capability.family,
        capability.status,
        capability.itemCount,
        capability.message,
      ]),
    ),
  ];

  if (inventory.warnings.length > 0) {
    sections.push('', '## Warnings', '', mdTable(
      ['Family', 'Severity', 'Message'],
      inventory.warnings.map((warning) => [warning.family, warning.severity, warning.message]),
    ));
  }

  sections.push('', '---', '', 'Metadata can reveal internal architecture. Review before sharing.', '');
  return sections.join('\n');
}
