import type { FastifyInstance } from 'fastify';
import { apiVersionSelectionSchema } from '@dcat/core';
import { invalidateOrgState } from './orgs.ts';
import { requireSessionToken } from '../security.ts';
import { setApiVersionSelection } from '../state.ts';
import type { AppState } from '../state.ts';

export function registerCompatibilityRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/compatibility', async () => state.compatibility);

  app.post('/api/compatibility', { preHandler: requireSessionToken(state.config) }, async (request, reply) => {
    const parsed = apiVersionSelectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_ARGUMENT', message: 'Choose a version DCAT supports.' },
      });
    }
    try {
      const compatibility = setApiVersionSelection(state, parsed.data);
      // Saved provenance is no longer accurate after a version change.
      invalidateOrgState(state);
      return compatibility;
    } catch {
      return reply.code(502).send({
        error: {
          code: 'COMPATIBILITY_SAVE_FAILED',
          message: "We couldn't save the API version on this computer. Try again.",
        },
      });
    }
  });
}
