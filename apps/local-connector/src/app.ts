import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ProcessRunner } from '@dcat/salesforce-cli';
import type { ConnectorConfig } from './config.ts';
import { registerSecurity } from './security.ts';
import { createAppState, refreshCliStatus } from './state.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerOrgRoutes } from './routes/orgs.ts';
import { registerSessionRoutes } from './routes/session.ts';
import { registerTransformRoutes } from './routes/transforms.ts';

export interface BuildAppOptions {
  config: ConnectorConfig;
  runner?: ProcessRunner;
}

export async function buildApp({ config, runner }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 16 * 1024 });
  registerSecurity(app, config);

  const state = createAppState(config, runner);
  await refreshCliStatus(state);

  registerHealthRoutes(app, state);
  registerSessionRoutes(app, state);
  registerOrgRoutes(app, state);
  registerTransformRoutes(app, state);

  const indexHtml = join(config.webDist, 'index.html');
  if (config.serveStatic && existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
    }
    if (config.serveStatic && existsSync(indexHtml)) {
      return reply.sendFile('index.html');
    }
    return reply
      .code(200)
      .type('text/plain')
      .send('DCAT connector is running. Start `npm run dev:web` for the workbench UI.');
  });

  return app;
}
