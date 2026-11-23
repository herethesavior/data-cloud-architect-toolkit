import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RESOURCE_FAMILIES } from '@dcat/core';
import type { InventorySnapshot, OrgSummary } from '@dcat/core';
import { discoverInventory } from '@dcat/data360-api';
import { validateAlias } from '@dcat/salesforce-cli';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { clearDiscoverySessions, getDiscoverySession, startDiscoverySession } from '../discovery-sessions.ts';
import type { AppState } from '../state.ts';
import { hasSessionToken, requireSessionToken } from '../security.ts';
import { sendRouteError } from './shared.ts';

const ORGS_CACHE_TTL_MS = 60_000;
const INVENTORY_CACHE_TTL_MS = 60_000;
const connectBodySchema = z.object({
  alias: z.string(),
  instanceUrl: z.string().optional(),
  browser: z.enum(['chrome', 'edge', 'firefox']).optional(),
});
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const discoveryStartSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  refresh: z.boolean().optional(),
});
const discoveryStatusSchema = z.object({
  resume: z.boolean().optional(),
  family: z.enum(RESOURCE_FAMILIES).optional(),
});

export async function resolveOrgs(state: AppState, force = false): Promise<OrgSummary[]> {
  if (state.mode === 'demo') return demoOrgs;
  const cached = state.orgsCache;
  if (!force && cached && Date.now() - cached.at < ORGS_CACHE_TTL_MS) return cached.orgs;
  const orgs = await state.cli.listOrgs();
  state.orgsCache = { at: Date.now(), orgs };
  return orgs;
}

export async function resolveInventory(state: AppState, org: OrgSummary, force = false): Promise<InventorySnapshot> {
  if (state.mode === 'demo') return demoInventory;
  const cached = state.inventoryCache;
  if (!force && cached && cached.alias === org.alias && Date.now() - cached.at < INVENTORY_CACHE_TTL_MS) {
    return cached.inventory;
  }
  const inventory = await discoverInventory({ cli: state.cli, alias: org.alias, org });
  state.inventoryCache = { at: Date.now(), alias: org.alias, inventory };
  return inventory;
}

async function findOrg(state: AppState, alias: string): Promise<OrgSummary | null> {
  const orgs = await resolveOrgs(state);
  return orgs.find((entry) => entry.alias === alias) ?? null;
}

/** An alias can be re-pointed to a different org, so none of its state survives login. */
export function invalidateOrgState(state: AppState): void {
  state.orgsCache = null;
  state.inventoryCache = null;
  clearDiscoverySessions(state);
}

export function registerOrgRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/orgs', async (_request, reply) => {
    try {
      return await resolveOrgs(state);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/orgs/refresh', { preHandler: requireSessionToken(state.config) }, async (_request, reply) => {
    try {
      return await resolveOrgs(state, true);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/orgs/connect', { preHandler: requireSessionToken(state.config) }, async (request, reply) => {
    try {
      const parsed = connectBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'A valid org alias is required.' } });
      }
      if (state.mode === 'demo') {
        return reply.code(400).send({
          error: { code: 'INVALID_ARGUMENT', message: 'Switch to live mode before connecting an org.' },
        });
      }
      const alias = validateAlias(parsed.data.alias);
      await state.cli.loginOrg(alias, parsed.data.instanceUrl, parsed.data.browser);
      invalidateOrgState(state);
      const orgs = await resolveOrgs(state, true);
      return (
        orgs.find((org) => org.alias === alias) ?? {
          alias,
          username: null,
          orgId: null,
          environment: 'unknown',
          connectedStatus: 'Connected',
          isDefault: true,
          isDevHub: false,
          source: 'salesforce-cli',
        }
      );
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/orgs/:alias', async (request, reply) => {
    try {
      const alias = validateAlias((request.params as { alias: string }).alias);
      const orgs = await resolveOrgs(state);
      const found = orgs.find((org) => org.alias === alias);
      if (!found) {
        return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } });
      }
      return state.mode === 'demo' ? found : state.cli.displayOrg(alias);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get('/api/orgs/:alias/inventory', async (request, reply) => {
    try {
      const alias = validateAlias((request.params as { alias: string }).alias);
      const org = await findOrg(state, alias);
      if (!org) {
        return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } });
      }
      const query = request.query as { refresh?: string };
      const force = query.refresh === '1' || query.refresh === 'true';
      // An <img> or fetch from another page can reach a loopback GET without a
      // token. Force-refresh spawns slow CLI processes, so require the token.
      if (force && !hasSessionToken(state.config, request.headers['x-dcat-token'])) {
        return reply.code(401).send({
          error: { code: 'INVALID_SESSION_TOKEN', message: 'Inventory refresh requires a session token.' },
        });
      }
      return await resolveInventory(state, org, force);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  // Progressive discovery. The first call returns the first page and starts a
  // background worker; status calls are cheap and can resume a failed family.
  app.post('/api/orgs/:alias/inventory/session', { preHandler: requireSessionToken(state.config) }, async (request, reply) => {
    try {
      const alias = validateAlias((request.params as { alias: string }).alias);
      const org = await findOrg(state, alias);
      if (!org) {
        return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } });
      }
      const parsed = discoveryStartSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Invalid discovery session request.' } });
      }
      return await startDiscoverySession(state, org, parsed.data);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post('/api/orgs/:alias/inventory/session/:sessionId', { preHandler: requireSessionToken(state.config) }, async (request, reply) => {
    try {
      const alias = validateAlias((request.params as { alias: string }).alias);
      const org = await findOrg(state, alias);
      if (!org) {
        return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } });
      }
      const sessionId = sessionIdSchema.safeParse((request.params as { sessionId: string }).sessionId);
      if (!sessionId.success) {
        return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Invalid discovery session id.' } });
      }
      const parsed = discoveryStatusSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Invalid discovery status request.' } });
      }
      return await getDiscoverySession(state, org, { sessionId: sessionId.data, ...parsed.data });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
