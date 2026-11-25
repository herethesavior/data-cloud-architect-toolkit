import { DurableObject } from 'cloudflare:workers';
import { RelayDurableObjectCore, type SqlStorageLike } from './relay-do.ts';
import type { Env } from './types.ts';

/** Runtime shell for the SQLite-backed relay state. Kept separate so unit tests stay runtime-agnostic. */
export class RelaySessionDO extends DurableObject<Env> {
  private readonly core: RelayDurableObjectCore;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.core = new RelayDurableObjectCore(state.storage.sql as unknown as SqlStorageLike);
  }

  override fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
