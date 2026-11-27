export type BridgeLogLevel = 'quiet' | 'info' | 'debug';

export interface BridgeLogger {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

/** `quiet` still keeps failures visible: a silent always-on agent is hard to diagnose. */
export function createBridgeLogger(sink: (message: string) => void, level: BridgeLogLevel): BridgeLogger {
  return {
    info: (message) => { if (level !== 'quiet') sink(message); },
    debug: (message) => { if (level === 'debug') sink(message); },
    error: (message) => { sink(message); },
  };
}

const FAILURE_REPEAT_WINDOW_MS = 5 * 60_000;

export interface FailureReporter {
  /** Log a failure once, then at most once per window while it keeps repeating. */
  report(key: string, message: string): void;
  success(): void;
}

export function createFailureReporter(logger: BridgeLogger, now: () => number = Date.now): FailureReporter {
  let activeKey: string | null = null;
  let activeMessage = '';
  let suppressed = 0;
  let reportedAt = 0;
  let announcedRecovery = false;

  return {
    report(key, message) {
      const at = now();
      if (key === activeKey) {
        suppressed += 1;
        // Keep the recovery latch: a flapping relay must not print a recovery
        // line after every repeated failure.
        if (at - reportedAt >= FAILURE_REPEAT_WINDOW_MS) {
          logger.error(`${activeMessage} (${suppressed} similar failures so far)`);
          suppressed = 0;
          reportedAt = at;
        }
        return;
      }
      if (suppressed > 0 && !announcedRecovery) {
        logger.debug(`${suppressed} repeated ${activeMessage}`);
      }
      activeKey = key;
      activeMessage = message;
      suppressed = 0;
      reportedAt = at;
      announcedRecovery = false;
      logger.error(message);
    },
    success() {
      // Do not reset the window here: a relay that flaps between failure and
      // success every few seconds must not print an error on every failure.
      if (suppressed > 0 && !announcedRecovery) {
        logger.info(`Reconnected after ${suppressed} failed ${suppressed === 1 ? 'request' : 'requests'}.`);
        announcedRecovery = true;
      }
    },
  };
}

export function resolveBridgeLogLevel(argv: readonly string[], env: NodeJS.ProcessEnv): BridgeLogLevel {
  const configured = env.DCAT_BRIDGE_LOG_LEVEL?.trim().toLowerCase();
  if (argv.includes('--quiet') || configured === 'quiet') return 'quiet';
  if (argv.includes('--verbose') || configured === 'debug' || configured === 'verbose') return 'debug';
  return 'info';
}
