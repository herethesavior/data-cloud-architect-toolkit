import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { sendError, sendRouteError } from './errors.ts';

function fakeContext() {
  const json = vi.fn((body: unknown, status: number) => ({ body, status }));
  return { context: { json } as unknown as Context, json };
}

describe('route error copy', () => {
  it('hides unexpected runtime detail from the browser', () => {
    const { context, json } = fakeContext();

    sendRouteError(context, new TypeError("Cannot read properties of undefined (reading 'idFromString')"));

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'REQUEST_FAILED', message: 'The service could not complete that request. Try again.' } },
      502,
    );
  });

  it('hides raw CLI output behind an untrusted code', () => {
    const { context, json } = fakeContext();

    sendRouteError(context, { code: 'COMMAND_FAILED', message: 'Salesforce CLI command failed: sf project deploy start' });

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'COMMAND_FAILED', message: 'The service could not complete that request. Try again.' } },
      502,
    );
  });

  it('keeps messages authored by the app', () => {
    const { context, json } = fakeContext();

    sendRouteError(context, { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' });

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'ORG_NOT_FOUND', message: 'Org alias is not authenticated.' } },
      404,
    );
  });

  it('replaces technical detail even when the code is trusted', () => {
    const { context, json } = fakeContext();

    sendRouteError(context, { code: 'NOT_FOUND', message: "TypeError: Cannot read properties of undefined (reading 'id')" });

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'NOT_FOUND', message: 'The request could not be completed.' } },
      404,
    );
  });

  it('redacts credentials in authored messages', () => {
    const { context, json } = fakeContext();

    sendError(context, 400, 'INVALID_ARGUMENT', 'Bearer abc123 was rejected.');

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'INVALID_ARGUMENT', message: 'Bearer [redacted] was rejected.' } },
      400,
    );
  });

  it('applies the same copy policy to relayed bridge errors', () => {
    const { context, json } = fakeContext();

    sendError(context, 409, 'COMMAND_FAILED', 'ZodError: invalid_field');

    expect(json).toHaveBeenCalledWith(
      { error: { code: 'COMMAND_FAILED', message: 'The service could not complete that request. Try again.' } },
      409,
    );
  });
});
