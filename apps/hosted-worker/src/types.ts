import type { CliStatus, RelayOperation, RelayResponse } from '@dcat/core';

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
  agentVersion: string | null;
  cli: CliStatus;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  request: RelayRequestRecord | null;
}

/** Agent-owned state. Kept out of the session record so polls cannot clobber browser writes. */
export interface RelayAgentState {
  lastSeenAt: number | null;
  agentVersion: string | null;
  cli: CliStatus;
}

export interface RelayClaimRecord {
  sessionId: string;
  claimedAt: number;
}

export interface RelayResponseRecord {
  response: RelayResponse;
  respondedAt: number;
}

export interface Env {
  DCAT_SESSIONS: KVNamespaceLike;
  ASSETS?: AssetFetcher;
  SESSION_TTL_SECONDS?: string;
}

export interface SessionRecord {
  id: string;
  csrf: string;
  mode: ConnectorMode;
  createdAt: number;
  relay: RelaySessionRecord;
}
