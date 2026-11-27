export type BridgeLogLevel = 'quiet' | 'info' | 'debug';
export type BridgeLogSeverity = 'debug' | 'info' | 'warn' | 'error';
export type BridgeLogFields = Record<string, string | number | boolean | null | undefined>;

export interface BridgeLogger {
  debug(message: string, fields?: BridgeLogFields): void;
  info(message: string, fields?: BridgeLogFields): void;
  warn(message: string, fields?: BridgeLogFields): void;
  error(message: string, fields?: BridgeLogFields): void;
}

const SEVERITY_WIDTH = 5;
const SCOPE_WIDTH = 9;

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One line per event: timestamp, severity, source, message, then key=value context. */
export function formatBridgeLine(
  severity: BridgeLogSeverity,
  scope: string,
  message: string,
  fields: BridgeLogFields = {},
  at: Date = new Date(),
): string {
  const context = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${oneLine(String(value))}`)
    .join(' ');
  return [
    at.toISOString(),
    severity.toUpperCase().padEnd(SEVERITY_WIDTH),
    scope.padEnd(SCOPE_WIDTH),
    oneLine(message),
    context,
  ].filter(Boolean).join(' ');
}

function isVisible(severity: BridgeLogSeverity, level: BridgeLogLevel): boolean {
  if (severity === 'warn' || severity === 'error') return true;
  if (severity === 'debug') return level === 'debug';
  return level !== 'quiet';
}

/** `quiet` still keeps warnings and errors visible: a silent always-on agent is hard to diagnose. */
export function createBridgeLogger(
  sink: (line: string) => void,
  level: BridgeLogLevel,
  scope = 'bridge',
  now: () => Date = () => new Date(),
): BridgeLogger {
  const emit = (severity: BridgeLogSeverity, message: string, fields?: BridgeLogFields) => {
    if (isVisible(severity, level)) sink(formatBridgeLine(severity, scope, message, fields, now()));
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export function formatDuration(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < 1_000) return `${Math.round(elapsed)}ms`;
  if (elapsed < 10_000) {
    const seconds = elapsed / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(2)}s`;
  }
  if (elapsed < 60_000) {
    const seconds = elapsed / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsed / 1_000)}s`;
}

const FAILURE_REPEAT_WINDOW_MS = 5 * 60_000;

export interface FailureReport {
  /** Stable identity for one failure mode; context such as request id stays in fields. */
  key: string;
  message: string;
  fields?: BridgeLogFields;
}

export interface FailureReporter {
  /** Log a failure once, then at most once per window while it keeps repeating. */
  report(report: FailureReport): void;
  success(): void;
}

export function createFailureReporter(logger: BridgeLogger, now: () => number = Date.now): FailureReporter {
  let active: FailureReport | null = null;
  let unreported = 0;
  let failuresSinceRecovery = 0;
  let reportedAt = 0;
  let lastFailureAt: number | null = null;
  let announcedRecovery = false;

  const emitSummary = () => {
    if (active && unreported > 0) logger.warn(active.message, { repeated: unreported });
  };

  return {
    report(report) {
      const at = now();
      if (lastFailureAt !== null && at - lastFailureAt > FAILURE_REPEAT_WINDOW_MS) {
        emitSummary();
        active = null;
        unreported = 0;
        failuresSinceRecovery = 0;
        announcedRecovery = false;
      }
      lastFailureAt = at;

      if (active?.key === report.key) {
        unreported += 1;
        failuresSinceRecovery += 1;
        // A flapping relay must not print a line on every failure.
        if (at - reportedAt >= FAILURE_REPEAT_WINDOW_MS) {
          emitSummary();
          unreported = 0;
          reportedAt = at;
        }
        return;
      }

      emitSummary();
      active = { ...report };
      unreported = 0;
      failuresSinceRecovery += 1;
      reportedAt = at;
      announcedRecovery = false;
      logger.warn(report.message, report.fields);
    },
    success() {
      if (!active || failuresSinceRecovery === 0 || announcedRecovery) return;
      const noun = failuresSinceRecovery === 1 ? 'failure' : 'failures';
      logger.info(`normal operation resumed after ${failuresSinceRecovery} ${noun}`);
      unreported = 0;
      announcedRecovery = true;
    },
  };
}

export function resolveBridgeLogLevel(argv: readonly string[], env: NodeJS.ProcessEnv): BridgeLogLevel {
  const configured = env.DCAT_BRIDGE_LOG_LEVEL?.trim().toLowerCase();
  if (argv.includes('--quiet') || configured === 'quiet') return 'quiet';
  if (argv.includes('--verbose') || configured === 'debug' || configured === 'verbose') return 'debug';
  return 'info';
}
