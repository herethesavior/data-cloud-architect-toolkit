import type { FastifyInstance } from 'fastify';
import type { AppState } from '../state.ts';
import { refreshCliStatus } from '../state.ts';
import { requireSessionToken } from '../security.ts';
import { sendRouteError } from './shared.ts';

export function registerHealthRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/health', async () => ({
    status: 'ok' as const,
    mode: state.mode,
    version: state.config.version,
    time: new Date().toISOString(),
    cli: state.cliStatus,
    compatibility: state.compatibility,
  }));

  app.get('/api/cli/status', async () => state.cliStatus);

  app.post('/api/cli/refresh', { preHandler: requireSessionToken(state.config) }, async (_request, reply) => {
    try {
      await refreshCliStatus(state);
      return state.cliStatus;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
