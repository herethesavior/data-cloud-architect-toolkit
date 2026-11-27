import { describe, expect, it, vi } from 'vitest';
import {
  createBridgeLogger,
  createFailureReporter,
  resolveBridgeLogLevel,
  type BridgeLogger,
} from './bridge-logging.ts';

function sinkLogger(): { logger: BridgeLogger; sink: ReturnType<typeof vi.fn> } {
  const sink = vi.fn();
  return { logger: createBridgeLogger(sink, 'info'), sink };
}

describe('bridge logging', () => {
  it('keeps progress lines at info and relay polls at debug', () => {
    const { logger, sink } = sinkLogger();
    logger.info('Running cli.status…');
    logger.debug('Polling the relay for work…');
    logger.error('Bridge stopped: no pairing.');

    expect(sink.mock.calls.map(([message]) => message)).toEqual([
      'Running cli.status…',
      'Bridge stopped: no pairing.',
    ]);
  });

  it('honors quiet and debug levels without hiding errors', () => {
    const quietSink = vi.fn();
    const quiet = createBridgeLogger(quietSink, 'quiet');
    quiet.info('Running cli.status…');
    quiet.debug('Polling…');
    quiet.error('Bridge stopped: no pairing.');
    expect(quietSink).toHaveBeenCalledTimes(1);
    expect(quietSink).toHaveBeenCalledWith('Bridge stopped: no pairing.');

    const debugSink = vi.fn();
    const debug = createBridgeLogger(debugSink, 'debug');
    debug.info('Running cli.status…');
    debug.debug('Polling…');
    expect(debugSink.mock.calls.map(([message]) => message)).toEqual([
      'Running cli.status…',
      'Polling…',
    ]);
  });

  it('resolves the level from CLI flags and the environment', () => {
    expect(resolveBridgeLogLevel(['start'], {})).toBe('info');
    expect(resolveBridgeLogLevel(['start', '--verbose'], {})).toBe('debug');
    expect(resolveBridgeLogLevel(['start'], { DCAT_BRIDGE_LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveBridgeLogLevel(['start'], { DCAT_BRIDGE_LOG_LEVEL: 'quiet' })).toBe('quiet');
    expect(resolveBridgeLogLevel(['start', '--quiet', '--verbose'], {})).toBe('quiet');
  });

  it('bounds repeated failures and announces recovery', () => {
    const logger: BridgeLogger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    let clock = 0;
    const reporter = createFailureReporter(logger, () => clock);
    const failure = 'Bridge request failed: Network down. Retrying.';

    reporter.report('relay', failure);
    reporter.report('relay', failure);
    clock = 4 * 60_000;
    reporter.report('relay', failure);
    expect(logger.error).toHaveBeenCalledTimes(1);

    clock = 5 * 60_000;
    reporter.report('relay', failure);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenLastCalledWith(`${failure} (3 similar failures so far)`);

    reporter.report('relay', failure);
    reporter.success();
    expect(logger.info).toHaveBeenCalledWith('Reconnected after 1 failed request.');
    reporter.report('relay', failure);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('does not restart the failure window for every successful poll', () => {
    const logger: BridgeLogger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const reporter = createFailureReporter(logger, () => 0);
    const failure = 'Bridge request failed: Network down. Retrying.';

    reporter.report('relay', failure);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      reporter.success();
      reporter.report('relay', failure);
    }

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
