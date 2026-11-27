import { Hono } from 'hono';
import { isValidTransformId } from '@dcat/core';
import { demoInventory, demoOrgs, demoTransformBundles } from '@dcat/test-fixtures';
import { sendError, sendRouteError } from '../errors.ts';
import { bridgeStatusForSession, clearRelayRequest, RELAY_VERSION } from '../relay.ts';
import { hasValidCsrf, resolveSession, saveSession } from '../session.ts';
import type { Env, SessionRecord } from '../types.ts';

function validAlias(alias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(alias) && !alias.includes('..');
}

function demoOrg(session: SessionRecord, alias: string) {
  if (session.mode !== 'demo') return null;
  return demoOrgs.find((org) => org.alias === alias) ?? null;
}

export function apiRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // A liveness probe must not consume KV reads. Bridge CLI details come from
  // /api/relay/status; this route only proves the Worker is answering.
  app.get('/api/health', (context) => context.json({
    status: 'ok',
    mode: 'live',
    version: RELAY_VERSION,
    time: new Date().toISOString(),
    cli: { installed: false, version: null, error: null },
  }));

  app.get('/api/cli/status', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      const status = await bridgeStatusForSession(context.env, session, new URL(context.req.url).origin);
      return context.json(status.cli);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/cli/refresh', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const status = await bridgeStatusForSession(context.env, session, new URL(context.req.url).origin);
      return context.json(status.cli);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/session', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      return context.json({ token: session.csrf, mode: session.mode });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/mode', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      const body = (await context.req.json().catch(() => ({}))) as { mode?: unknown };
      if (body.mode !== 'live' && body.mode !== 'demo') {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'Unknown mode.');
      }
      session.mode = body.mode;
      session.relay.request = null;
      await clearRelayRequest(context.env, session);
      await saveSession(context, context.env, session);
      return context.json({ mode: session.mode });
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/orgs', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      return context.json(session.mode === 'demo' ? demoOrgs : []);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.post('/api/orgs/refresh', async (context) => {
    try {
      const session = await resolveSession(context, context.env);
      if (!hasValidCsrf(context, session)) {
        return sendError(context, 401, 'INVALID_SESSION_TOKEN', 'Refresh the page and try again.');
      }
      return context.json(session.mode === 'demo' ? demoOrgs : []);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/orgs/:alias', async (context) => {
    try {
      const alias = context.req.param('alias');
      if (!validAlias(alias)) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'The org alias contains unsupported characters.');
      }
      const session = await resolveSession(context, context.env);
      const org = demoOrg(session, alias);
      if (!org) return sendError(context, 404, 'ORG_NOT_FOUND', 'Org alias is not authenticated.');
      return context.json(org);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/orgs/:alias/inventory', async (context) => {
    try {
      const alias = context.req.param('alias');
      if (!validAlias(alias)) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'The org alias contains unsupported characters.');
      }
      const session = await resolveSession(context, context.env);
      const org = demoOrg(session, alias);
      if (!org) return sendError(context, 404, 'ORG_NOT_FOUND', 'Org alias is not authenticated.');
      return context.json(demoInventory);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  app.get('/api/orgs/:alias/data-transforms/:id', async (context) => {
    try {
      const alias = context.req.param('alias');
      if (!validAlias(alias)) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'The org alias contains unsupported characters.');
      }
      const id = context.req.param('id');
      if (!isValidTransformId(id)) {
        return sendError(context, 400, 'INVALID_ARGUMENT', 'The transform id contains unsupported characters.');
      }
      const session = await resolveSession(context, context.env);
      if (!demoOrg(session, alias)) {
        return sendError(context, 404, 'ORG_NOT_FOUND', 'Org alias is not authenticated.');
      }
      const bundle = demoTransformBundles[id];
      if (!bundle) {
        return sendError(context, 404, 'TRANSFORM_NOT_FOUND', 'Demo transform id was not recognized.');
      }
      return context.json(bundle);
    } catch (error) {
      return sendRouteError(context, error);
    }
  });

  return app;
}
