import { RelayDurableObjectCore, type SqlResultLike, type SqlStorageLike } from './relay-do.ts';
import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
  Env,
  KVNamespaceLike,
} from './types.ts';

export class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  reads = 0;
  writes = 0;
  removals = 0;

  async get(key: string): Promise<string | null> {
    this.reads += 1;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.puts.push(key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.removals += 1;
    this.deletes.push(key);
    this.store.delete(key);
  }
}

interface FakeRequestRow {
  id: string;
  operation: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  response: string | null;
  responded_at: number | null;
}

/** The subset of SQLite used by `RelayDurableObjectCore`, enough for fast unit tests. */
export class FakeSqlStorage implements SqlStorageLike {
  private readonly meta = new Map<string, string>();
  private request: FakeRequestRow | null = null;

  exec(query: string, ...bindings: unknown[]): SqlResultLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const rows = (values: Array<Record<string, unknown>>): SqlResultLike => ({ toArray: () => values });

    if (sql.startsWith('CREATE TABLE')) return rows([]);
    if (sql.startsWith('SELECT value FROM relay_meta')) {
      const value = this.meta.get(String(bindings[0]));
      return rows(value === undefined ? [] : [{ value }]);
    }
    if (sql.startsWith('INSERT INTO relay_meta')) {
      this.meta.set(String(bindings[0]), String(bindings[1]));
      return rows([]);
    }
    if (sql.startsWith('DELETE FROM relay_meta')) {
      this.meta.clear();
      return rows([]);
    }
    if (sql.includes('FROM current_request') && sql.startsWith('SELECT')) {
      return rows(this.request ? [{ ...this.request }] : []);
    }
    if (sql.startsWith('DELETE FROM current_request')) {
      this.request = null;
      return rows([]);
    }
    if (sql.startsWith('INSERT INTO current_request')) {
      this.request = {
        id: String(bindings[0]),
        operation: String(bindings[1]),
        created_at: Number(bindings[2]),
        expires_at: Number(bindings[3]),
        claimed_at: bindings[4] === null || bindings[4] === undefined ? null : Number(bindings[4]),
        response: typeof bindings[5] === 'string' ? bindings[5] : null,
        responded_at: bindings[6] === null || bindings[6] === undefined ? null : Number(bindings[6]),
      };
      return rows([]);
    }
    if (sql.startsWith('UPDATE current_request SET claimed_at')) {
      if (this.request) this.request.claimed_at = Number(bindings[0]);
      return rows([]);
    }
    if (sql.startsWith('UPDATE current_request SET response')) {
      if (this.request) {
        this.request.response = String(bindings[0]);
        this.request.responded_at = Number(bindings[1]);
      }
      return rows([]);
    }
    throw new Error(`Unexpected fake SQL: ${sql}`);
  }
}

class FakeId implements DurableObjectIdLike {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export class FakeRelayDO implements DurableObjectNamespaceLike {
  readonly instances = new Map<string, RelayDurableObjectCore>();

  idFromString(id: string): DurableObjectIdLike {
    return new FakeId(id);
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const key = id.toString();
    let core = this.instances.get(key);
    if (!core) {
      core = new RelayDurableObjectCore(new FakeSqlStorage());
      this.instances.set(key, core);
    }
    return {
      fetch: (request: Request) => core!.fetch(request),
    };
  }
}

export function makeTestEnv(kv: FakeKV = new FakeKV(), relayDo: FakeRelayDO = new FakeRelayDO()): Env {
  return { DCAT_SESSIONS: kv, RELAY_DO: relayDo };
}
