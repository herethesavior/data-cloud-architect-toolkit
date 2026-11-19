import type { DataLakeObject, DataModelObject, DataStream, InventorySnapshot, RelationshipEdge } from '@dcat/core';
import { sameName } from './inventory.ts';

export type ExplorerObject = DataLakeObject | DataModelObject;
export type ExplorerKind = 'dlo' | 'dmo';

/** Request from global search to open a specific drawer after navigation. */
export interface FocusObject {
  kind: ExplorerKind | 'stream' | 'transform';
  apiName: string;
}

export interface ObjectLinks {
  mappings: InventorySnapshot['mappings'];
  relationships: RelationshipEdge[];
  streams: DataStream[];
}

/** Linkages are derived only from fields present in the current snapshot. */
export function objectLinks(inventory: InventorySnapshot, object: ExplorerObject): ObjectLinks {
  const apiName = object.apiName;
  return {
    mappings: inventory.mappings.filter(
      (mapping) => sameName(mapping.sourceObject, apiName) || sameName(mapping.targetObject, apiName),
    ),
    relationships: inventory.relationships.filter(
      (edge) => sameName(edge.source, apiName) || sameName(edge.target, apiName),
    ),
    streams: inventory.dataStreams.filter((stream) => sameName(stream.targetDlo, apiName)),
  };
}

/** A sanitized, user-initiated summary. Never includes session or credential data. */
export function objectMarkdown(object: ExplorerObject, kind: ExplorerKind, links: ObjectLinks): string {
  const lines = [
    `# ${object.label ?? object.apiName}`,
    '',
    `- Type: ${kind.toUpperCase()}`,
    `- API name: \`${object.apiName}\``,
    `- Data space: ${object.dataSpace ?? 'Not recorded'}`,
    `- Fields: ${object.fields.length}`,
    `- Mappings: ${links.mappings.length}`,
    `- Relationships: ${links.relationships.length}`,
    `- Streams: ${links.streams.length}`,
    '',
    '## Fields',
    ...object.fields.map((field) => {
      const detail = [field.label, field.description].filter(Boolean).join(' — ');
      return `- \`${field.apiName}\`${detail ? ` — ${detail}` : ''}`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}
