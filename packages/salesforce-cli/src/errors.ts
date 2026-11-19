export const CLI_ERROR_CODES = [
  'CLI_NOT_FOUND',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'COMMAND_FAILED',
  'UNEXPECTED_RESPONSE',
  'INVALID_ARGUMENT',
  'SESSION_EXPIRED',
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
  }
}
