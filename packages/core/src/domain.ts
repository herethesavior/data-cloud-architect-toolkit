import { z } from 'zod';

export const RESOURCE_FAMILIES = [
  'data-spaces',
  'dlos',
  'dmos',
  'mappings',
  'data-streams',
  'data-transforms',
] as const;

export type ResourceFamily = (typeof RESOURCE_FAMILIES)[number];

export const RETRIEVAL_STATUSES = [
  'not-started',
  'available',
  'unsupported',
  'forbidden',
  'error',
  'partial',
] as const;

export type RetrievalStatus = (typeof RETRIEVAL_STATUSES)[number];

export const retrievalStatusSchema = z.enum(RETRIEVAL_STATUSES);

export const resourceProvenanceSchema = z.object({
  orgId: z.string(),
  orgAlias: z.string(),
  sourceEndpoint: z.string(),
  apiVersion: z.string(),
  retrievedAt: z.string(),
  confidence: z.enum(['source', 'derived']),
});

export type ResourceProvenance = z.infer<typeof resourceProvenanceSchema>;

export const orgSummarySchema = z.object({
  alias: z.string(),
  username: z.string().nullish(),
  orgId: z.string().nullish(),
  instanceUrl: z.string().nullish(),
  loginUrl: z.string().nullish(),
  environment: z.enum(['production', 'sandbox', 'scratch', 'dev-hub', 'other', 'unknown']),
  connectedStatus: z.string().nullish(),
  isDefault: z.boolean(),
  isDevHub: z.boolean(),
  source: z.enum(['salesforce-cli', 'demo-fixture']),
});

export type OrgSummary = z.infer<typeof orgSummarySchema>;

export interface OrgEnvironmentInput {
  environment?: OrgSummary['environment'] | null;
  instanceUrl?: string | null;
  loginUrl?: string | null;
  isDevHub?: boolean | null;
  isSandbox?: boolean | null;
  isScratch?: boolean | null;
}

function hostnameOf(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Salesforce CLI output varies by org type. Prefer explicit auth metadata, then
 * well-known hostnames, without treating every hyphenated My Domain as a sandbox.
 */
export function inferOrgEnvironment(input: OrgEnvironmentInput): OrgSummary['environment'] {
  if (input.environment && input.environment !== 'unknown') return input.environment;

  const hosts = [hostnameOf(input.instanceUrl), hostnameOf(input.loginUrl)].filter(Boolean);
  const isScratch = input.isScratch === true
    || hosts.some((host) => host.includes('.scratch.') || host.includes('.trailblaze.'));
  const isSandbox = input.isSandbox === true
    || hosts.some((host) => host === 'test.salesforce.com' || host.includes('.sandbox.'));
  const isProduction = input.isSandbox === false
    || hosts.some((host) => host === 'login.salesforce.com' || host.endsWith('.my.salesforce.com'));

  if (isScratch) return 'scratch';
  if (input.isDevHub === true) return 'dev-hub';
  if (isSandbox) return 'sandbox';
  if (isProduction) return 'production';
  return 'unknown';
}

export const apiCapabilitySchema = z.object({
  family: z.enum([...RESOURCE_FAMILIES, 'api-versions']),
  status: z.enum(RETRIEVAL_STATUSES),
  endpoint: z.string(),
  apiVersion: z.string().nullish(),
  message: z.string().nullish(),
  durationMs: z.number().nullish(),
  itemCount: z.number().nullish(),
});

export type ApiCapability = z.infer<typeof apiCapabilitySchema>;

export const dataFieldSchema = z.object({
  apiName: z.string(),
  label: z.string().nullish(),
  dataType: z.string().nullish(),
  description: z.string().nullish(),
  isPrimaryKey: z.boolean(),
  isNullable: z.boolean().nullish(),
  provenance: resourceProvenanceSchema,
});

export type DataField = z.infer<typeof dataFieldSchema>;

export const dataSpaceSchema = z.object({
  id: z.string().nullish(),
  apiName: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  isDefault: z.boolean().nullish(),
  provenance: resourceProvenanceSchema,
});

export type DataSpace = z.infer<typeof dataSpaceSchema>;

export const dataLakeObjectSchema = z.object({
  apiName: z.string(),
  label: z.string().nullish(),
  category: z.string().nullish(),
  dataSpace: z.string().nullish(),
  source: z.string().nullish(),
  fields: z.array(dataFieldSchema),
  provenance: resourceProvenanceSchema,
});

export type DataLakeObject = z.infer<typeof dataLakeObjectSchema>;

export const dataModelObjectSchema = z.object({
  apiName: z.string(),
  label: z.string().nullish(),
  category: z.string().nullish(),
  dataSpace: z.string().nullish(),
  isCustom: z.boolean().nullish(),
  /** Source `isEnabled` flag; used to avoid mapping lookups for unused standard DMOs. */
  isEnabled: z.boolean().nullish(),
  hasExternalDataLakeObjectMappings: z.boolean().nullish(),
  fields: z.array(dataFieldSchema),
  provenance: resourceProvenanceSchema,
});

export type DataModelObject = z.infer<typeof dataModelObjectSchema>;

export const dataMappingSchema = z.object({
  apiName: z.string().nullish(),
  sourceObject: z.string(),
  targetObject: z.string(),
  fieldMappings: z.array(
    z.object({
      sourceField: z.string(),
      targetField: z.string(),
      transformation: z.string().nullish(),
    }),
  ),
  provenance: resourceProvenanceSchema,
});

export type DataMapping = z.infer<typeof dataMappingSchema>;

/** Best-effort provenance for connector catalog and connection lookups. */
export const connectorLookupSchema = z.object({
  endpoints: z.array(z.string()),
  apiVersion: z.string(),
  retrievedAt: z.string(),
});

export type ConnectorLookup = z.infer<typeof connectorLookupSchema>;

export const dataStreamSchema = z.object({
  apiName: z.string(),
  label: z.string().nullish(),
  /** Raw connector code from stream metadata, preserved for stable joins and exports. */
  sourceConnector: z.string().nullish(),
  /** Human-readable connector type resolved from the Data 360 connector catalog. */
  sourceConnectorLabel: z.string().nullish(),
  /** Connection name embedded in the stream, before any catalog lookup. */
  sourceConnectionName: z.string().nullish(),
  /** Configured connection label resolved from /ssot/connections. */
  sourceConnectionLabel: z.string().nullish(),
  sourceConnectionStatus: z.string().nullish(),
  sourceDataSource: z.string().nullish(),
  connectorLookup: connectorLookupSchema.nullish(),
  targetDlo: z.string().nullish(),
  /** Directly attributed when Salesforce returns `dataSpaceInfo`; otherwise joined from the target DLO. */
  dataSpace: z.string().nullish(),
  status: z.string().nullish(),
  refreshMetadata: z.string().nullish(),
  provenance: resourceProvenanceSchema,
});

export type DataStream = z.infer<typeof dataStreamSchema>;

export const dataTransformSchema = z.object({
  apiName: z.string(),
  label: z.string().nullish(),
  status: z.string().nullish(),
  description: z.string().nullish(),
  id: z.string().nullish(),
  type: z.string().nullish(),
  inputs: z.array(z.string()).nullish(),
  outputs: z.array(z.string()).nullish(),
  lastRunStatus: z.string().nullish(),
  lastRunAt: z.string().nullish(),
  schedule: z.string().nullish(),
  definition: z.string().nullish(),
  dataSpace: z.string().nullish(),
  createdAt: z.string().nullish(),
  modifiedAt: z.string().nullish(),
  owner: z.string().nullish(),
  raw: z.unknown().nullish(),
  provenance: resourceProvenanceSchema,
});

export type DataTransform = z.infer<typeof dataTransformSchema>;

export const transformRunSchema = z.object({
  id: z.string(),
  status: z.string().nullish(),
  startedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
  durationMs: z.number().nullish(),
  recordsProcessed: z.number().nullish(),
  message: z.string().nullish(),
  provenance: resourceProvenanceSchema,
});

export type TransformRun = z.infer<typeof transformRunSchema>;

export const transformScheduleSchema = z.object({
  cadence: z.string().nullish(),
  timezone: z.string().nullish(),
  nextRunAt: z.string().nullish(),
  lastRunAt: z.string().nullish(),
  enabled: z.boolean().nullish(),
  raw: z.unknown().nullish(),
  provenance: resourceProvenanceSchema,
});

export type TransformSchedule = z.infer<typeof transformScheduleSchema>;

export const transformBundleSchema = z.object({
  transform: dataTransformSchema.nullable(),
  runs: z.array(transformRunSchema),
  schedule: transformScheduleSchema.nullable(),
  sections: z.object({
    detail: retrievalStatusSchema,
    runHistory: retrievalStatusSchema,
    schedule: retrievalStatusSchema,
  }),
  messages: z.object({
    detail: z.string().nullish(),
    runHistory: z.string().nullish(),
    schedule: z.string().nullish(),
  }),
});

export type TransformBundle = z.infer<typeof transformBundleSchema>;

export const relationshipEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().nullish(),
  cardinality: z.string().nullish(),
  /** Source status when the endpoint supplies one; never inferred by DCAT. */
  status: z.string().nullish(),
  /** Explicit target-side join field when the endpoint supplies one. */
  targetField: z.string().nullish(),
  certainty: z.enum(['confirmed', 'inferred', 'unknown']),
  provenance: resourceProvenanceSchema,
});

export type RelationshipEdge = z.infer<typeof relationshipEdgeSchema>;

export const retrievalWarningSchema = z.object({
  family: z.string(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
});

export type RetrievalWarning = z.infer<typeof retrievalWarningSchema>;

export const DISCOVERY_SESSION_STATES = ['running', 'partial', 'complete', 'failed'] as const;
export type DiscoverySessionState = (typeof DISCOVERY_SESSION_STATES)[number];

export const FAMILY_PROGRESS_STATES = [
  'not-started',
  'running',
  'partial',
  'complete',
  'failed',
  'skipped',
] as const;
export type FamilyProgressState = (typeof FAMILY_PROGRESS_STATES)[number];

/**
 * Per-family retrieval counters. `total` is the conservative page-derived value;
 * `expectedTotal` is only set when Salesforce reports an authoritative final
 * count before or during loading. The UI must never turn an unknown total into
 * a misleading denominator.
 */
export const familyProgressSchema = z.object({
  family: z.enum(RESOURCE_FAMILIES),
  status: z.enum(FAMILY_PROGRESS_STATES),
  loaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  expectedTotal: z.number().int().nonnegative().nullable().optional(),
  expectedTotalSource: z.enum(['preflight', 'response']).nullable().optional(),
  pagesFetched: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  error: z.string().nullish(),
  /** Classification behind `error`; retry UI must not offer forbidden/unsupported families. */
  errorStatus: retrievalStatusSchema.nullish(),
});

export type FamilyProgress = z.infer<typeof familyProgressSchema>;

export const discoveryProgressSchema = z.object({
  sessionId: z.string(),
  generation: z.string(),
  state: z.enum(DISCOVERY_SESSION_STATES),
  loaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  families: z.array(familyProgressSchema),
  message: z.string().nullish(),
});

export type DiscoveryProgress = z.infer<typeof discoveryProgressSchema>;

export const inventorySnapshotSchema = z.object({
  org: orgSummarySchema,
  apiVersion: z.string().nullish(),
  generatedAt: z.string(),
  mode: z.enum(['live', 'demo']),
  capabilities: z.array(apiCapabilitySchema),
  dataSpaces: z.array(dataSpaceSchema),
  dlos: z.array(dataLakeObjectSchema),
  dmos: z.array(dataModelObjectSchema),
  mappings: z.array(dataMappingSchema),
  dataStreams: z.array(dataStreamSchema),
  dataTransforms: z.array(dataTransformSchema),
  relationships: z.array(relationshipEdgeSchema),
  warnings: z.array(retrievalWarningSchema),
  progress: discoveryProgressSchema.optional(),
});

export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;

export const cliStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullish(),
  error: z.string().nullish(),
});

export type CliStatus = z.infer<typeof cliStatusSchema>;

export const connectorHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  mode: z.enum(['live', 'demo']),
  version: z.string(),
  time: z.string(),
  cli: cliStatusSchema,
});

export type ConnectorHealth = z.infer<typeof connectorHealthSchema>;

export const sessionInfoSchema = z.object({
  token: z.string(),
  mode: z.enum(['live', 'demo']),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;
