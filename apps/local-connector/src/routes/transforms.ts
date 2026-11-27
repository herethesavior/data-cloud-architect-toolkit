import type { FastifyInstance } from 'fastify';
import type { TransformBundle } from '@dcat/core';
import { createUnsupportedTransformBundle, fetchTransformBundle, validateTransformId } from '@dcat/data360-api';
import { validateAlias } from '@dcat/salesforce-cli';
import { demoTransformBundles } from '@dcat/test-fixtures';
import type { AppState } from '../state.ts';
import { validateApiVersionHint, resolveTransformContext } from '../transform-context.ts';
import { resolveOrgs } from './orgs.ts';
import { sendRouteError } from './shared.ts';

export function registerTransformRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/orgs/:alias/data-transforms/:id', async (request, reply) => {
    try {
      const alias = validateAlias((request.params as { alias: string }).alias);
      const id = validateTransformId((request.params as { id: string }).id);

      if (state.mode === 'demo') {
        const bundle: TransformBundle | undefined = demoTransformBundles[id];
        if (!bundle) {
          return reply.code(404).send({
            error: { code: 'TRANSFORM_NOT_FOUND', message: 'Demo transform id was not recognized.' },
          });
        }
        // Plain GET needs no write token; this is a labelled, read-only fixture.
        return bundle;
      }

      const orgs = await resolveOrgs(state);
      const org = orgs.find((entry) => entry.alias === alias);
      if (!org) {
        return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } });
      }

      const query = request.query as { apiVersion?: unknown };
      const apiVersion = validateApiVersionHint(query.apiVersion);
      const context = await resolveTransformContext(state, org, id, apiVersion);
      if (!context.apiVersion) {
        return createUnsupportedTransformBundle(
          context.seed,
          'No API version is available for this org, so transform detail endpoints were not requested.',
        );
      }

      return await fetchTransformBundle({
        client: state.cli,
        alias,
        apiVersion: context.apiVersion,
        id,
        seed: context.seed,
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
