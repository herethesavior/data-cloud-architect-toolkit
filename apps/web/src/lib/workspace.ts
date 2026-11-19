import type { OrgSummary } from '@dcat/core';
import type { QueryClient } from '@tanstack/react-query';

export type WorkspaceMode = 'demo' | 'live';

/** A workspace is a complete data context, not a visual filter. */
export interface WorkspaceContext {
  mode: WorkspaceMode;
  /** Unique per mode + org session; used as the namespace for every data cache. */
  contextId: string;
  alias: string | null;
  orgId: string | null;
  orgName: string | null;
  environment: OrgSummary['environment'] | 'demo';
}

const CONTEXT_SCOPED_QUERIES = ['inventory', 'transforms', 'erd'] as const;
const CONTEXT_ID_PATTERN = /^(?:demo:[^:]+|live:[^:]+:[^:]+)$/;

/** The org list is scoped by mode so persisted results cannot cross a Demo/Live boundary. */
export function orgsQueryKey(mode: WorkspaceMode): readonly ['orgs', WorkspaceMode] {
  return ['orgs', mode];
}

export function isWorkspaceContextId(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_ID_PATTERN.test(value);
}

export function createWorkspaceContext(
  mode: WorkspaceMode,
  org: OrgSummary | null,
): WorkspaceContext | null {
  if (!org) return null;
  return {
    mode,
    contextId: mode === 'demo'
      ? `demo:${org.alias}`
      : `live:${org.alias}:${org.orgId ?? 'unverified'}`,
    alias: org.alias,
    orgId: org.orgId ?? null,
    orgName: org.alias,
    environment: mode === 'demo' ? 'demo' : org.environment,
  };
}

export function isContextScopedQuery(queryKey: readonly unknown[]): boolean {
  return (CONTEXT_SCOPED_QUERIES as readonly string[]).includes(String(queryKey[0]));
}

/** Cached data belongs to one context only; never let a prior org's data flash. */
export function shouldDiscardQuery(queryKey: readonly unknown[], activeContextId: string | null): boolean {
  if (!isContextScopedQuery(queryKey)) return false;
  if (activeContextId === null) return true;
  return queryKey[1] !== activeContextId;
}

export function clearWorkspaceCaches(queryClient: QueryClient, activeContextId: string | null): void {
  void queryClient.cancelQueries({ predicate: (query) => isContextScopedQuery(query.queryKey) });
  queryClient.removeQueries({ predicate: (query) => shouldDiscardQuery(query.queryKey, activeContextId) });
}

/**
 * Bridge changes affect setup, diagnostics, and cached inventory, but must not
 * re-enqueue `org.list`: a pairing refresh could then slip between `org.connect`
 * and the first `inventory.get`. Active observers refetch immediately; inactive
 * views are marked stale and refetch when opened.
 */
export function invalidateBridgeState(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['bridge-status'] });
  void queryClient.invalidateQueries({ queryKey: ['health'] });
  void queryClient.invalidateQueries({
    predicate: (query) => isContextScopedQuery(query.queryKey),
  });
}

/** Mode changes also replace the org list, so include it explicitly. */
export function invalidateWorkspaceState(queryClient: QueryClient): void {
  invalidateBridgeState(queryClient);
  void queryClient.invalidateQueries({ queryKey: ['orgs'] });
}

export function workspaceBadge(
  context: WorkspaceContext | null,
  mode: WorkspaceMode = 'live',
): { label: string; tone: 'warning' | 'success' | 'neutral' } {
  if (!context) {
    return mode === 'demo'
      ? { label: 'DEMO · NO ORG SELECTED', tone: 'warning' }
      : { label: 'LIVE · NOT CONNECTED', tone: 'neutral' };
  }
  if (context.mode === 'demo') return { label: 'DEMO DATA', tone: 'warning' };
  const environment = context.environment === 'unknown' ? 'UNKNOWN' : context.environment.toUpperCase();
  return { label: `LIVE · ${environment}`, tone: 'success' };
}
