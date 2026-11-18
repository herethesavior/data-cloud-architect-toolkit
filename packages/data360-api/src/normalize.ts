import type {
  DataField,
  DataLakeObject,
  DataMapping,
  DataModelObject,
  DataSpace,
  DataStream,
  DataTransform,
  RelationshipEdge,
  ResourceProvenance,
} from '@dcat/core';
import { CliError } from '@dcat/salesforce-cli';

export interface NormalizeContext {
  orgId: string;
  orgAlias: string;
  apiVersion: string;
  endpoint: string;
  retrievedAt: string;
}

export interface NormalizedCollection<T> {
  items: T[];
  skipped: number;
}

export interface NormalizedDmos extends NormalizedCollection<DataModelObject> {
  relationships: RelationshipEdge[];
}

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonResponse(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError('UNEXPECTED_RESPONSE', `The ${label} response was not valid JSON.`);
  }
}

const ENVELOPE_KEYS = ['records', 'items', 'results', 'entities', 'values', 'dataSpaces', 'spaces', 'dlos', 'dataLakeObjects', 'dmos', 'dataModelObjects', 'mappings', 'dataModelObjectMappings', 'dataStreams', 'streams', 'dataTransforms', 'transforms', 'runs', 'runHistory', 'transformRuns', 'executions'];
const CONTAINER_KEYS = ['result', 'data', 'response', 'payload'];

/**
 * Accept the common documented envelopes without assuming any of them.
 * A response we cannot recognize is an error, never an empty dataset.
 */
export function extractCollection(raw: unknown, label: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) {
    throw new CliError('UNEXPECTED_RESPONSE', `The ${label} response was not a JSON object or array.`);
  }

  const containers = [raw];
  for (const key of CONTAINER_KEYS) {
    const nested = raw[key];
    if (isRecord(nested)) containers.push(nested);
  }

  let firstArray: unknown[] | null = null;
  for (const container of containers) {
    for (const key of ENVELOPE_KEYS) {
      const value = container[key];
      if (!Array.isArray(value)) continue;
      firstArray ??= value;
      // Prefer a populated envelope. Returning the first empty array could
      // silently discard real records under another alias.
      if (value.length > 0) return value;
    }
  }
  if (firstArray) return firstArray;

  throw new CliError('UNEXPECTED_RESPONSE', `The ${label} response did not contain a recognizable collection.`);
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return null;
}

function firstString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstBoolean(record: JsonRecord, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = asBoolean(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[\s,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Accept a returned array or a comma-separated list; never synthesize names. */
function asStringArray(record: JsonRecord, keys: readonly string[]): string[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null);
    }
    const text = asString(value);
    if (text) {
      const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    }
  }
  return null;
}

/** Only an explicit batch/streaming value is normalized; api names are never inferred. */
export function normalizeTransformType(value: unknown): 'Batch' | 'Streaming' | null {
  const text = asString(value);
  if (/^batch$/i.test(text ?? '')) return 'Batch';
  if (/^streaming$/i.test(text ?? '')) return 'Streaming';
  return null;
}

/** Keep returned definitions readable without rewriting their contents. */
export function toDefinitionText(value: unknown): string | null {
  if (typeof value === 'string') return asString(value);
  if (Array.isArray(value) || isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function firstStringValue(record: JsonRecord, keys: readonly string[]): string | null {
  return firstString(record, keys);
}

export function firstNumberValue(record: JsonRecord, keys: readonly string[]): number | null {
  return firstNumber(record, keys);
}

export function firstBooleanValue(record: JsonRecord, keys: readonly string[]): boolean | null {
  return firstBoolean(record, keys);
}

export function stringArrayValue(record: JsonRecord, keys: readonly string[]): string[] | null {
  return asStringArray(record, keys);
}

export function makeProvenance(context: NormalizeContext, confidence: ResourceProvenance['confidence'] = 'source'): ResourceProvenance {
  return {
    orgId: context.orgId,
    orgAlias: context.orgAlias,
    sourceEndpoint: context.endpoint,
    apiVersion: context.apiVersion,
    retrievedAt: context.retrievedAt,
    confidence,
  };
}

function fieldSource(entry: JsonRecord): unknown {
  if (entry.fields !== undefined) return entry.fields;
  if (entry.fieldDefinitions !== undefined) return entry.fieldDefinitions;
  if (isRecord(entry.schema)) return entry.schema.fields ?? entry.schema.fieldDefinitions;
  if (isRecord(entry.attributes)) return entry.attributes.fields;
  return undefined;
}

function normalizeFields(value: unknown, context: NormalizeContext): DataField[] {
  if (!Array.isArray(value)) return [];
  const fields: DataField[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const apiName = firstString(entry, ['apiName', 'name', 'fieldName', 'developerName', 'Name', 'FieldName']);
    if (!apiName) continue;

    const required = firstBoolean(entry, ['isRequired', 'required']);
    const nullable = firstBoolean(entry, ['isNullable', 'nullable']);
    fields.push({
      apiName,
      label: firstString(entry, ['label', 'displayName', 'fieldLabel', 'Label']),
      dataType: firstString(entry, ['dataType', 'fieldType', 'type', 'DataType', 'Type']),
      description: firstString(entry, ['description', 'desc', 'Description']),
      isPrimaryKey: firstBoolean(entry, ['isPrimaryKey', 'primaryKey', 'isPrimary']) ?? false,
      isNullable: nullable ?? (required === null ? null : !required),
      provenance: makeProvenance(context),
    });
  }

  return fields;
}

export function normalizeDataSpaces(raw: unknown, context: NormalizeContext): NormalizedCollection<DataSpace> {
  const entries = extractCollection(raw, 'Data Spaces');
  const items: DataSpace[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const apiName = firstString(entry, ['apiName', 'name', 'developerName', 'spaceName', 'Name', 'id']);
    if (!apiName) {
      skipped += 1;
      continue;
    }
    items.push({
      id: firstString(entry, ['id', 'spaceId', 'Id']),
      apiName,
      label: firstString(entry, ['label', 'displayName', 'Label', 'name']),
      description: firstString(entry, ['description', 'desc', 'Description']),
      isDefault: firstBoolean(entry, ['isDefault', 'default', 'isDefaultSpace']),
      provenance: makeProvenance(context),
    });
  }

  return { items, skipped };
}

export function normalizeDlos(raw: unknown, context: NormalizeContext): NormalizedCollection<DataLakeObject> {
  const entries = extractCollection(raw, 'Data Lake Objects');
  const items: DataLakeObject[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const apiName = firstString(entry, ['apiName', 'name', 'developerName', 'objectName', 'Name']);
    if (!apiName) {
      skipped += 1;
      continue;
    }
    items.push({
      apiName,
      label: firstString(entry, ['label', 'displayName', 'Label']),
      category: firstString(entry, ['category', 'objectCategory', 'Category']),
      dataSpace: firstString(entry, ['dataSpace', 'dataSpaceName', 'space', 'DataSpace']),
      source: firstString(entry, ['source', 'sourceName', 'sourceObject', 'connector']),
      fields: normalizeFields(fieldSource(entry), context),
      provenance: makeProvenance(context),
    });
  }

  return { items, skipped };
}

export function normalizeDmos(raw: unknown, context: NormalizeContext): NormalizedDmos {
  const entries = extractCollection(raw, 'Data Model Objects');
  const items: DataModelObject[] = [];
  const relationships: RelationshipEdge[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const apiName = firstString(entry, ['apiName', 'name', 'developerName', 'objectName', 'Name']);
    if (!apiName) {
      skipped += 1;
      continue;
    }
    items.push({
      apiName,
      label: firstString(entry, ['label', 'displayName', 'Label']),
      category: firstString(entry, ['category', 'objectCategory', 'Category']),
      dataSpace: firstString(entry, ['dataSpace', 'dataSpaceName', 'space', 'DataSpace']),
      isCustom: firstBoolean(entry, ['isCustom', 'custom', 'isCustomObject']),
      fields: normalizeFields(fieldSource(entry), context),
      provenance: makeProvenance(context),
    });

    const sourceRelationships = entry.relationships;
    if (!Array.isArray(sourceRelationships)) continue;
    for (const relation of sourceRelationships) {
      if (!isRecord(relation)) continue;
      // Never fall back to the relation's own apiName/name: those describe the
      // join field, not the target object, and would fabricate a confirmed edge.
      const target = firstString(relation, [
        'targetObject', 'targetObjectApiName', 'referenceTo', 'relatedTo',
        'targetDmo', 'targetDmoApiName', 'target', 'targetApiName', 'targetName',
        'relatedObject', 'relatedObjectApiName',
      ]);
      if (!target) continue;
      relationships.push({
        id: `source:${apiName}:${target}:${firstString(relation, ['joinField', 'sourceField', 'field']) ?? 'relationship'}`,
        source: apiName,
        target,
        label: firstString(relation, ['joinField', 'field', 'label', 'sourceField']),
        cardinality: firstString(relation, ['cardinality', 'relationshipType', 'type']),
        certainty: 'confirmed',
        provenance: makeProvenance(context),
      });
    }
  }

  return { items, skipped, relationships };
}

export function normalizeMappings(raw: unknown, context: NormalizeContext): NormalizedCollection<DataMapping> {
  const entries = extractCollection(raw, 'Mappings');
  const items: DataMapping[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const sourceObject = firstString(entry, ['sourceObject', 'sourceObjectName', 'sourceObjectApiName', 'source', 'from']);
    const targetObject = firstString(entry, ['targetObject', 'targetObjectName', 'targetObjectApiName', 'target', 'to']);
    if (!sourceObject || !targetObject) {
      skipped += 1;
      continue;
    }

    const rawFields = entry.fieldMappings ?? entry.fieldMapping ?? entry.fields;
    const fieldMappings: DataMapping['fieldMappings'] = [];
    if (Array.isArray(rawFields)) {
      for (const field of rawFields) {
        if (!isRecord(field)) continue;
        const sourceField = firstString(field, ['sourceField', 'sourceFieldName', 'source', 'from']);
        const targetField = firstString(field, ['targetField', 'targetFieldName', 'target', 'to']);
        if (!sourceField || !targetField) continue;
        fieldMappings.push({
          sourceField,
          targetField,
          transformation: firstString(field, ['transformation', 'transform', 'transformType']),
        });
      }
    }

    items.push({
      apiName: firstString(entry, ['apiName', 'name', 'developerName', 'mappingName']),
      sourceObject,
      targetObject,
      fieldMappings,
      provenance: makeProvenance(context),
    });
  }

  return { items, skipped };
}

export function normalizeDataStreams(raw: unknown, context: NormalizeContext): NormalizedCollection<DataStream> {
  const entries = extractCollection(raw, 'Data Streams');
  const items: DataStream[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const apiName = firstString(entry, ['apiName', 'name', 'developerName', 'streamName', 'Name']);
    if (!apiName) {
      skipped += 1;
      continue;
    }
    items.push({
      apiName,
      label: firstString(entry, ['label', 'displayName', 'Label']),
      sourceConnector: firstString(entry, ['sourceConnector', 'connector', 'sourceName', 'source']),
      targetDlo: firstString(entry, ['targetDlo', 'targetDloName', 'targetObject', 'dlo', 'target']),
      status: firstString(entry, ['status', 'streamStatus', 'ingestionStatus', 'Status']),
      refreshMetadata: firstString(entry, ['refreshMetadata', 'refreshRate', 'lastRefreshed', 'lastRun']),
      provenance: makeProvenance(context),
    });
  }

  return { items, skipped };
}

export function normalizeDataTransforms(raw: unknown, context: NormalizeContext): NormalizedCollection<DataTransform> {
  const entries = extractCollection(raw, 'Data Transforms');
  const items: DataTransform[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const apiName = firstString(entry, ['apiName', 'name', 'developerName', 'transformName', 'Name']);
    if (!apiName) {
      skipped += 1;
      continue;
    }
    items.push({
      apiName,
      label: firstString(entry, ['label', 'displayName', 'Label']),
      // Transform Status and Last Run Status are separate concepts.
      status: firstString(entry, ['status', 'transformStatus', 'Status']),
      description: firstString(entry, ['description', 'desc', 'Description']),
      id: firstString(entry, ['id', 'transformId', 'dataTransformId', 'Id']),
      type: normalizeTransformType(
        entry.type ?? entry.transformType ?? entry.Type ?? entry.kind,
      ) ?? undefined,
      inputs: stringArrayValue(entry, ['inputs', 'inputObjects', 'sourceObjects', 'inputObject', 'sourceObject', 'InputObjects']),
      outputs: stringArrayValue(entry, ['outputs', 'outputObjects', 'targetObjects', 'outputObject', 'targetObject', 'OutputObjects']),
      lastRunStatus: firstString(entry, ['lastRunStatus', 'lastRunState', 'mostRecentRunStatus', 'LastRunStatus']),
      lastRunAt: firstString(entry, ['lastRunAt', 'lastRunDate', 'lastRunTimestamp', 'lastRunTime', 'LastRunAt']),
      schedule: toDefinitionText(
        entry.schedule ?? entry.scheduleSummary ?? entry.cadence ?? entry.scheduleDescription ?? entry.frequency,
      ),
      definition: toDefinitionText(
        entry.definition ?? entry.transformDefinition ?? entry.sql ?? entry.sqlExpression ?? entry.pipeline ?? entry.pipelineDefinition,
      ),
      dataSpace: firstString(entry, ['dataSpace', 'dataSpaceName', 'space', 'DataSpace']),
      createdAt: firstString(entry, ['createdAt', 'createdDate', 'createdOn', 'CreatedDate']),
      modifiedAt: firstString(entry, ['modifiedAt', 'lastModifiedAt', 'modifiedDate', 'LastModifiedDate']),
      owner: firstString(entry, ['owner', 'ownerName', 'createdBy', 'CreatedBy']),
      raw: entry,
      provenance: makeProvenance(context),
    });
  }

  return { items, skipped };
}

/**
 * Conservative inference: a field named <Object>Id suggests a link to a DMO
 * whose name contains <Object>. Every resulting edge is marked inferred and
 * carries derived provenance so it is never mistaken for source metadata.
 */
export function deriveInferredRelationships(dmos: DataModelObject[], context: NormalizeContext): RelationshipEdge[] {
  const candidates = dmos.map((dmo) => ({
    dmo,
    apiName: dmo.apiName.toLowerCase(),
    label: (dmo.label ?? dmo.apiName).toLowerCase(),
  }));
  const edges: RelationshipEdge[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    for (const field of candidate.dmo.fields) {
      const match = /^(.+?)Id$/i.exec(field.apiName);
      if (!match) continue;
      const base = match[1]!.toLowerCase();
      if (base.length < 2) continue;

      const target = candidates.find((item) =>
        item.dmo.apiName !== candidate.dmo.apiName
        && (item.apiName.includes(base) || item.label.includes(base)),
      );
      if (!target) continue;

      const id = `inferred:${candidate.dmo.apiName}:${target.dmo.apiName}:${field.apiName}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        id,
        source: candidate.dmo.apiName,
        target: target.dmo.apiName,
        label: field.apiName,
        cardinality: null,
        certainty: 'inferred',
        provenance: makeProvenance(context, 'derived'),
      });
    }
  }

  return edges;
}
