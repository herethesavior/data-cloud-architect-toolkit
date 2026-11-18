import type {
  DataTransform,
  RetrievalStatus,
  TransformBundle,
  TransformRun,
  TransformSchedule,
} from '@dcat/core';
import { CliError, redactSensitive, safeErrorMessage } from '@dcat/salesforce-cli';
import { classifyRestFailure } from './capabilities.ts';
import type { RestClient } from './discover.ts';
import { extractHttpStatus, fetchCollection } from './discover.ts';
import { buildTransformDetailPath, buildTransformRunHistoryPath, buildTransformSchedulePath } from './endpoints.ts';
import {
  extractCollection,
  firstBooleanValue,
  firstNumberValue,
  firstStringValue,
  isRecord,
  makeProvenance,
  normalizeDataTransforms,
  parseJsonResponse,
  toDefinitionText,
} from './normalize.ts';
import type { NormalizeContext } from './normalize.ts';

export const MAX_TRANSFORM_RUN_PAGES = 20;

export interface FetchTransformBundleOptions {
  client: RestClient;
  alias: string;
  apiVersion: string;
  id: string;
  /** Transform metadata from the inventory list, used when detail retrieval fails. */
  seed?: DataTransform | null;
  maxPages?: number;
}

interface SectionState {
  status: RetrievalStatus;
  message: string;
}

type FailureStatus = Extract<RetrievalStatus, 'forbidden' | 'unsupported' | 'error'>;

const SINGLE_CONTAINER_KEYS = ['dataTransform', 'transform', 'schedule', 'data', 'result', 'response', 'payload'];
const SINGLE_COLLECTION_KEYS = ['dataTransforms', 'transforms', 'records', 'items', 'results', 'runs', 'runHistory', 'transformRuns', 'schedules'];

function sectionFailure(error: unknown): { status: FailureStatus; message: string } {
  const message = safeErrorMessage(error);
  return classifyRestFailure(extractHttpStatus(message), message);
}

/** Keep raw metadata useful for diagnostics without returning credential-shaped values. */
function sanitizeRaw(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(redactSensitive(JSON.stringify(value)));
  } catch {
    return null;
  }
}

function sanitizeTransform(transform: DataTransform): DataTransform {
  return transform.raw === null || transform.raw === undefined
    ? transform
    : { ...transform, raw: sanitizeRaw(transform.raw) };
}

/** Accept documented single-resource envelopes without guessing at unknown shapes. */
function unwrapRecord(raw: unknown, label: string): Record<string, unknown> {
  let current = raw;
  for (let depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(current)) {
      current = current[0] ?? null;
      continue;
    }
    if (!isRecord(current)) break;
    const record: Record<string, unknown> = current;
    const nested = SINGLE_CONTAINER_KEYS
      .map((key) => record[key])
      .find((value) => isRecord(value) || Array.isArray(value))
      ?? SINGLE_COLLECTION_KEYS
        .map((key) => record[key])
        .find((value) => Array.isArray(value) && (value as unknown[]).length > 0);
    if (nested !== undefined) {
      current = nested;
      continue;
    }
    if (Object.keys(record).length === 0) break;
    return record;
  }
  throw new CliError('UNEXPECTED_RESPONSE', `The ${label} response did not contain a recognizable object.`);
}

function hasEmptyCollection(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.length === 0;
  if (!isRecord(raw)) return false;
  return SINGLE_COLLECTION_KEYS.some((key) => Array.isArray(raw[key]) && raw[key].length === 0)
    && !SINGLE_CONTAINER_KEYS.some((key) => isRecord(raw[key]));
}

export function normalizeTransformRuns(raw: unknown, context: NormalizeContext): TransformRun[] {
  const entries = extractCollection(raw, 'Transform Run History');
  const runs: TransformRun[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    const id = firstStringValue(entry, ['id', 'runId', 'Id', 'executionId']);
    // A run without an id cannot be identified safely; never invent one.
    if (!id) continue;

    const startedAt = firstStringValue(entry, ['startedAt', 'startTime', 'startDate', 'started', 'StartTime']);
    const endedAt = firstStringValue(entry, ['endedAt', 'endTime', 'endDate', 'completedAt', 'EndTime']);
    let durationMs = firstNumberValue(entry, ['durationMs', 'duration', 'elapsedMs', 'durationMilliseconds']);
    if (durationMs === null && startedAt && endedAt) {
      const derived = Date.parse(endedAt) - Date.parse(startedAt);
      if (Number.isFinite(derived) && derived >= 0) durationMs = derived;
    }

    runs.push({
      id,
      status: firstStringValue(entry, ['status', 'runStatus', 'result', 'state', 'RunStatus']),
      startedAt,
      endedAt,
      durationMs,
      recordsProcessed: firstNumberValue(entry, [
        'recordsProcessed', 'processedRecords', 'rowsProcessed', 'recordCount', 'processedRows', 'RecordsProcessed',
      ]),
      message: firstStringValue(entry, ['message', 'errorMessage', 'statusMessage', 'error', 'notes', 'Message']),
      provenance: makeProvenance(context),
    });
  }

  return runs;
}

export function normalizeTransformSchedule(raw: unknown, context: NormalizeContext): TransformSchedule {
  const record = unwrapRecord(raw, 'Transform Schedule');
  return {
    cadence: toDefinitionText(
      record.cadence ?? record.frequency ?? record.schedule ?? record.scheduleSummary
        ?? record.interval ?? record.cron ?? record.cronExpression,
    ),
    timezone: firstStringValue(record, ['timezone', 'timeZone', 'tz']),
    nextRunAt: firstStringValue(record, ['nextRunAt', 'nextRun', 'nextFireTime', 'nextScheduledRun']),
    lastRunAt: firstStringValue(record, ['lastRunAt', 'lastRunDate', 'lastFireTime']),
    enabled: firstBooleanValue(record, ['enabled', 'isEnabled', 'active', 'isActive']),
    raw: record,
    provenance: makeProvenance(context),
  };
}

/** Used when the caller already knows no transform endpoints can be requested. */
export function createUnsupportedTransformBundle(seed: DataTransform | null, message: string): TransformBundle {
  return {
    transform: seed,
    runs: [],
    schedule: null,
    sections: { detail: 'unsupported', runHistory: 'unsupported', schedule: 'unsupported' },
    messages: {
      detail: `${message} ${seed ? 'Showing the transform from the inventory list; detail fields were not requested.' : 'No transform metadata could be read.'}`.trim(),
      runHistory: `${message} Run history was not requested.`,
      schedule: `${message} Schedule metadata was not requested.`,
    },
  };
}

/**
 * Lazy, read-only transform detail. Each section is fetched independently so a
 * denied or unsupported subresource never blanks the other sections. Only the
 * three allowlisted GET paths are used; callers cannot pass a URL or path.
 */
export async function fetchTransformBundle(options: FetchTransformBundleOptions): Promise<TransformBundle> {
  const { client, alias, apiVersion, id, seed = null } = options;
  const detailPath = buildTransformDetailPath(id, apiVersion);
  const runHistoryPath = buildTransformRunHistoryPath(id, apiVersion);
  const schedulePath = buildTransformSchedulePath(id, apiVersion);
  const maxPages = Math.min(MAX_TRANSFORM_RUN_PAGES, Math.max(1, options.maxPages ?? MAX_TRANSFORM_RUN_PAGES));
  const base = {
    orgId: seed?.provenance.orgId ?? alias,
    orgAlias: alias,
    retrievedAt: new Date().toISOString(),
  };

  let transform: DataTransform | null = null;
  let detailState: SectionState;
  try {
    const decoded = parseJsonResponse(await client.restGet(alias, detailPath), 'Transform Detail');
    const record = unwrapRecord(decoded, 'Transform Detail');
    const normalized = normalizeDataTransforms([record], {
      ...base,
      apiVersion,
      endpoint: detailPath,
    }).items[0];
    if (!normalized) {
      throw new CliError('UNEXPECTED_RESPONSE', 'The transform detail response did not contain a recognizable data transform.');
    }
    transform = sanitizeTransform(normalized);
    detailState = {
      status: 'available',
      message: 'Transform details were retrieved from the detail endpoint.',
    };
  } catch (error) {
    const failure = sectionFailure(error);
    transform = seed ? sanitizeTransform(seed) : null;
    detailState = {
      status: failure.status,
      message: seed
        ? `${failure.message} Showing the transform from the inventory list; detail fields may be incomplete.`
        : `${failure.message} Transform details are unavailable.`,
    };
  }

  let runs: TransformRun[] = [];
  let runHistoryState: SectionState;
  try {
    const fetched = await fetchCollection(client, alias, runHistoryPath, 'Transform Run History', maxPages);
    runs = normalizeTransformRuns(fetched.entries, {
      ...base,
      apiVersion,
      endpoint: runHistoryPath,
    });
    const prefix = fetched.warnings.length > 0
      ? `Retrieved ${runs.length} run(s) with warnings: ${fetched.warnings.join(' ')}`
      : `Retrieved ${runs.length} run(s) from the run history endpoint.`;
    runHistoryState = {
      status: fetched.warnings.length > 0 ? 'partial' : 'available',
      message: runs.length === 0
        ? 'The run history endpoint returned no runs for this transform.'
        : prefix,
    };
  } catch (error) {
    const failure = sectionFailure(error);
    runHistoryState = { status: failure.status, message: failure.message };
  }

  let schedule: TransformSchedule | null = null;
  let scheduleState: SectionState;
  try {
    const decoded = parseJsonResponse(await client.restGet(alias, schedulePath), 'Transform Schedule');
    if (hasEmptyCollection(decoded)) {
      scheduleState = {
        status: 'available',
        message: 'The schedule endpoint returned no schedule metadata for this transform.',
      };
    } else {
      schedule = normalizeTransformSchedule(decoded, {
        ...base,
        apiVersion,
        endpoint: schedulePath,
      });
      schedule = { ...schedule, raw: sanitizeRaw(schedule.raw) };
      scheduleState = {
        status: 'available',
        message: 'Schedule metadata was retrieved from the schedule endpoint.',
      };
    }
  } catch (error) {
    const failure = sectionFailure(error);
    scheduleState = { status: failure.status, message: failure.message };
  }

  return {
    transform,
    runs,
    schedule,
    sections: {
      detail: detailState.status,
      runHistory: runHistoryState.status,
      schedule: scheduleState.status,
    },
    messages: {
      detail: detailState.message,
      runHistory: runHistoryState.message,
      schedule: scheduleState.message,
    },
  };
}
