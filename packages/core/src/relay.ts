import { z } from 'zod';
import { RESOURCE_FAMILIES, cliStatusSchema, inventorySnapshotSchema, orgSummarySchema, transformBundleSchema } from './domain.ts';

export const RELAY_OPERATIONS = [
  'cli.status',
  'org.list',
  'org.connect',
  'inventory.get',
  'inventory.start',
  'inventory.status',
  'transform.get',
  'mode.set',
  'bridge.update',
] as const;

const aliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);

const instanceUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /^[A-Za-z0-9.-]+\.salesforce\.com$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'Use only a base https://<domain>.salesforce.com URL.');

export const relayOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('cli.status') }),
  z.object({ operation: z.literal('org.list') }),
  z.object({
    operation: z.literal('org.connect'),
    alias: aliasSchema,
    instanceUrl: instanceUrlSchema.optional(),
    browser: z.enum(['chrome', 'edge', 'firefox']).optional(),
  }),
  z.object({
    operation: z.literal('inventory.get'),
    alias: aliasSchema,
    refresh: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('inventory.start'),
    alias: aliasSchema,
    // Reusing an opaque session id is idempotent; refresh starts a new generation.
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    refresh: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('inventory.status'),
    alias: aliasSchema,
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    resume: z.boolean().optional(),
    family: z.enum(RESOURCE_FAMILIES).optional(),
  }),
  z.object({
    operation: z.literal('transform.get'),
    alias: aliasSchema,
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  }),
  z.object({
    operation: z.literal('mode.set'),
    mode: z.enum(['live', 'demo']),
  }),
  z.object({ operation: z.literal('bridge.update') }),
]);

export type RelayOperation = z.infer<typeof relayOperationSchema>;
export type RelayOperationName = RelayOperation['operation'];

export const relayPairingSchema = z.object({
  code: z.string(),
  expiresAt: z.string(),
  installCommand: z.string(),
});

export type RelayPairing = z.infer<typeof relayPairingSchema>;

export const bridgeStatusSchema = z.object({
  paired: z.boolean(),
  mode: z.enum(['live', 'demo']),
  version: z.string(),
  cli: cliStatusSchema,
  lastSeenAt: z.string().nullish(),
  relay: z.enum(['waiting', 'connected', 'stale']),
  pairing: relayPairingSchema.nullable(),
  agentVersion: z.string().nullish(),
  latestVersion: z.string().nullish(),
  updateAvailable: z.boolean(),
  selfUpdateSupported: z.boolean(),
});

export type BridgeStatus = z.infer<typeof bridgeStatusSchema>;

export const relayTaskSchema = z.object({
  id: z.string(),
  operation: relayOperationSchema,
  createdAt: z.string(),
});

export type RelayTask = z.infer<typeof relayTaskSchema>;

export const relayRequestStateSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'expired']),
  result: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export type RelayRequestState = z.infer<typeof relayRequestStateSchema>;

export const relayResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type RelayResponse = z.infer<typeof relayResponseSchema>;

export const relayPairRequestSchema = z.object({
  code: z.string().min(8).max(64),
  version: z.string().max(64).optional(),
  cli: cliStatusSchema.optional(),
});

export const relayPollRequestSchema = z.object({
  agentToken: z.string().min(16),
  version: z.string().max(64).optional(),
  cli: cliStatusSchema.optional(),
});

export const relayRespondRequestSchema = z.object({
  agentToken: z.string().min(16),
  response: relayResponseSchema,
});

export const relayHealthResultSchema = cliStatusSchema;
export const relayOrgsResultSchema = z.array(orgSummarySchema);
export const relayInventoryResultSchema = inventorySnapshotSchema;
export const relayTransformResultSchema = transformBundleSchema;

/** The CLI's web-login command never carries credentials into the toolkit. */
export const orgConnectResultSchema = z.object({
  alias: aliasSchema,
  connected: z.literal(true),
});
