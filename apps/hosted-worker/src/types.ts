import type { ApiVersionStatus, CliStatus, RelayOperation } from '@dcat/core';

export type ConnectorMode = 'live' | 'demo';

/** The subset of Workers KV this Worker uses, kept local so typecheck needs no Cloudflare globals. */
export interface KVNamespaceLike {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AssetFetcher {
  fetch(request: Request | string): Promise<Response>;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromString(id: string): DurableObjectIdLike;
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface RelayRequestRecord {
  id: string;
  operation: RelayOperation;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'expired';
  result: unknown | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  expiresAt: number;
}

export interface RelaySessionRecord {
  agentToken: string | null;
  pairedAt: number | null;
  lastSeenAt: number | null;
  /** True while the bridge has claimed a long-running operation. */
  working?: boolean;
  agentVersion: string | null;
  cli: CliStatus;
  compatibility?: ApiVersionStatus | null;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  request: RelayRequestRecord | null;
}

export interface Env {
  DCAT_SESSIONS: KVNamespaceLike;
  /** SQLite-backed relay state; one object per agent token. */
  RELAY_DO: DurableObjectNamespaceLike;
  ASSETS?: AssetFetcher;
  SESSION_TTL_SECONDS?: string;
}

export interface SessionRecord {
  id: string;
  csrf: string;
  mode: ConnectorMode;
  createdAt: number;
  /** Mirrors the KV TTL so the Durable Object can stop an orphaned bridge. */
  expiresAt?: number;
  relay: RelaySessionRecord;
}
