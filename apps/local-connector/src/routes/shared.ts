import type { FastifyReply } from 'fastify';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';

export function sendRouteError(reply: FastifyReply, error: unknown, fallbackCode = 'REQUEST_FAILED') {
  const code = error instanceof CliError ? error.code : fallbackCode;
  const status = code === 'INVALID_ARGUMENT' ? 400 : 502;
  return reply.code(status).send({ error: { code, message: safeErrorMessage(error) } });
}
