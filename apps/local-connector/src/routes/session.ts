import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppState } from '../state.ts';
import { refreshCliStatus } from '../state.ts';
import { clearDiscoverySessions } from '../discovery-sessions.ts';
import { requireSessionToken } from '../security.ts';

const modeBodySchema = z.object({ mode: z.enum(['live', 'demo']) });

export function registerSessionRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/session', async () => ({ token: state.config.sessionToken, mode: state.mode }));

  app.post('/api/mode', { preHandler: requireSessionToken(state.config) }, async (request, reply) => {
    const parsed = modeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Unknown mode.' } });
    }
    clearDiscoverySessions(state);
    state.mode = parsed.data.mode;
    state.orgsCache = null;
    state.inventoryCache = null;
    if (state.mode === 'live') void refreshCliStatus(state);
    return { mode: state.mode };
  });
}
