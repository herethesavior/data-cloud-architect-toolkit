import { inferOrgEnvironment } from '@dcat/core';
import type { OrgSummary } from '@dcat/core';
import { z } from 'zod';
import { CliError } from './errors.ts';

const cliOrgEntrySchema = z
  .object({
    alias: z.string().nullish(),
    username: z.string().nullish(),
    orgId: z.string().nullish(),
    id: z.string().nullish(),
    instanceUrl: z.string().nullish(),
    loginUrl: z.string().nullish(),
    connectedStatus: z.string().nullish(),
    isDefaultUsername: z.boolean().nullish(),
    isDefaultDevHubUsername: z.boolean().nullish(),
    isDevHub: z.boolean().nullish(),
    isScratch: z.boolean().nullish(),
    isScratchOrg: z.boolean().nullish(),
    isSandbox: z.boolean().nullish(),
  })
  .passthrough();

type CliOrgEntry = z.infer<typeof cliOrgEntrySchema>;

const orgListSchema = z.object({
  status: z.number().optional(),
  result: z.union([
    z
      .object({
        other: z.array(cliOrgEntrySchema).optional(),
        nonScratchOrgs: z.array(cliOrgEntrySchema).optional(),
        sandboxes: z.array(cliOrgEntrySchema).optional(),
        devHubs: z.array(cliOrgEntrySchema).optional(),
        scratchOrgs: z.array(cliOrgEntrySchema).optional(),
        nonScratchOrgInfos: z.array(cliOrgEntrySchema).optional(),
        orgs: z.array(cliOrgEntrySchema).optional(),
        defaults: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    z.array(cliOrgEntrySchema),
  ]),
});

const orgDisplaySchema = z.object({
  status: z.number().optional(),
  result: cliOrgEntrySchema,
});

function decode(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(
      'UNEXPECTED_RESPONSE',
      `${label} did not return valid JSON. The Salesforce CLI output format may have changed.`,
    );
  }
}

function detectEnvironment(entry: CliOrgEntry): OrgSummary['environment'] {
  return inferOrgEnvironment({
    instanceUrl: entry.instanceUrl,
    loginUrl: entry.loginUrl,
    isDevHub: entry.isDevHub,
    isSandbox: entry.isSandbox,
    isScratch: entry.isScratch ?? entry.isScratchOrg,
  });
}

function toOrgSummary(entry: CliOrgEntry, defaultUsername?: string): OrgSummary {
  return {
    alias: entry.alias ?? entry.username ?? 'unknown',
    username: entry.username ?? null,
    orgId: entry.orgId ?? entry.id ?? null,
    instanceUrl: entry.instanceUrl ?? null,
    loginUrl: entry.loginUrl ?? null,
    environment: detectEnvironment(entry),
    connectedStatus: entry.connectedStatus ?? null,
    isDefault: entry.isDefaultUsername === true || (!!defaultUsername && defaultUsername === entry.username),
    isDevHub: entry.isDevHub === true || entry.isDefaultDevHubUsername === true,
    source: 'salesforce-cli',
  };
}

/** Parse `sf org list --json` defensively across known CLI output shapes. */
export function parseOrgList(raw: string): OrgSummary[] {
  const parsed = orgListSchema.safeParse(decode(raw, 'sf org list'));
  if (!parsed.success) {
    throw new CliError(
      'UNEXPECTED_RESPONSE',
      'The Salesforce CLI org list format was not recognized. Update the CLI or check the adapter.',
    );
  }

  const result = parsed.data.result;
  const knownCollections = [
    'other',
    'nonScratchOrgs',
    'nonScratchOrgInfos',
    'sandboxes',
    'devHubs',
    'scratchOrgs',
    'orgs',
  ] as const;
  if (
    !Array.isArray(result) &&
    !knownCollections.some((key) => Array.isArray((result as Record<string, unknown>)[key]))
  ) {
    throw new CliError(
      'UNEXPECTED_RESPONSE',
      'The Salesforce CLI org list did not contain a recognized org collection.',
    );
  }

  const entries: CliOrgEntry[] = Array.isArray(result)
    ? result
    : [
        ...(result.other ?? []),
        ...(result.nonScratchOrgs ?? []),
        ...(result.nonScratchOrgInfos ?? []),
        ...(result.sandboxes ?? []),
        ...(result.devHubs ?? []),
        ...(result.scratchOrgs ?? []),
        ...(result.orgs ?? []),
      ];

  const defaultUsername =
    !Array.isArray(result) && typeof result.defaults?.username === 'string'
      ? result.defaults.username
      : undefined;

  const byKey = new Map<string, OrgSummary>();
  for (const entry of entries) {
    const summary = toOrgSummary(entry, defaultUsername);
    const key = summary.username ?? summary.orgId ?? summary.alias;
    const existing = byKey.get(key);
    if (!existing || (!existing.alias && summary.alias)) byKey.set(key, summary);
  }

  return [...byKey.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Parse `sf org display --target-org <alias> --json` into safe identity fields only. */
export function parseOrgDisplay(raw: string): OrgSummary {
  const parsed = orgDisplaySchema.safeParse(decode(raw, 'sf org display'));
  if (!parsed.success) {
    throw new CliError(
      'UNEXPECTED_RESPONSE',
      'The Salesforce CLI org display format was not recognized. Update the CLI or check the adapter.',
    );
  }
  return toOrgSummary(parsed.data.result);
}

/** Extract the CLI version from `sf --version` output. */
export function parseCliVersion(raw: string): string | null {
  const match = /(?:@salesforce\/cli\/|salesforce-cli\/)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(raw);
  if (match) return match[1] ?? null;
  const firstLine = raw.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const versionOnly = /\bv?(\d+\.\d+\.\d+)\b/.exec(firstLine);
  return versionOnly?.[1] ?? null;
}
