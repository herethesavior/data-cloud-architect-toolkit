import { describe, expect, it, vi } from 'vitest';
import {
  createBridgeLogger,
  createFailureReporter,
  formatBridgeLine,
  formatDuration,
  resolveBridgeLogLevel,
  type BridgeLogger,
  type FailureReport,
} from './bridge-logging.ts';

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies BridgeLogger;
}

describe('bridge logging', () => {
  it('formats one line per event with severity, source, and context', () => {
    expect(formatBridgeLine(
      'warn',
      'bridge',
      'relay failed\nagain',
      { request: 'task-1', retryIn: '2s', skipped: undefined },
      new Date('2026-11-27T15:04:05.123Z'),
    )).toBe('2026-11-27T15:04:05.123Z WARN  bridge    relay failed again request=task-1 retryIn=2s');
  });

  it('formats durations in the unit a reader can act on', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(1_234)).toBe('1.23s');
    expect(formatDuration(2_000)).toBe('2s');
    expect(formatDuration(12_345)).toBe('12.3s');
    expect(formatDuration(65_000)).toBe('65s');
  });

  it('shows warnings at every level and reserves debug for verbose output', () => {
    const at = new Date('2026-11-27T15:04:05.123Z');
    const sink = vi.fn();
    const logger = createBridgeLogger(sink, 'debug', 'test', () => at);
    logger.debug('poll');
    logger.info('ready');
    logger.warn('retrying');
    logger.error('stopping');

    expect(sink.mock.calls.map(([line]) => line)).toEqual([
      '2026-11-27T15:04:05.123Z DEBUG test      poll',
      '2026-11-27T15:04:05.123Z INFO  test      ready',
      '2026-11-27T15:04:05.123Z WARN  test      retrying',
      '2026-11-27T15:04:05.123Z ERROR test      stopping',
    ]);

    const defaultSink = vi.fn();
    const defaultLogger = createBridgeLogger(defaultSink, 'info', 'test', () => at);
    defaultLogger.debug('poll');
    defaultLogger.info('ready');
    expect(defaultSink).toHaveBeenCalledTimes(1);

    const quietSink = vi.fn();
    const quietLogger = createBridgeLogger(quietSink, 'quiet', 'test', () => at);
    quietLogger.debug('poll');
    quietLogger.info('ready');
    quietLogger.warn('retrying');
    quietLogger.error('stopping');
    expect(quietSink).toHaveBeenCalledTimes(2);
    expect(quietSink.mock.calls.map(([line]) => line)).toEqual([
      '2026-11-27T15:04:05.123Z WARN  test      retrying',
      '2026-11-27T15:04:05.123Z ERROR test      stopping',
    ]);
  });

  it('resolves the level from CLI flags and the environment', () => {
    expect(resolveBridgeLogLevel(['start'], {})).toBe('info');
    expect(resolveBridgeLogLevel(['start', '--verbose'], {})).toBe('debug');
    expect(resolveBridgeLogLevel(['start'], { DCAT_BRIDGE_LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveBridgeLogLevel(['start'], { DCAT_BRIDGE_LOG_LEVEL: 'quiet' })).toBe('quiet');
    expect(resolveBridgeLogLevel(['start', '--quiet', '--verbose'], {})).toBe('quiet');
  });

  it('summarizes repeated failures without reusing the first failure duration', () => {
    const logger = mockLogger();
    let clock = 0;
    const reporter = createFailureReporter(logger, () => clock);
    const failure: FailureReport = {
      key: 'cli.status:Network down',
      message: 'cli.status failed: Network down',
      fields: { request: 'task-1', duration: '12ms' },
    };

    reporter.report(failure);
    expect(logger.warn).toHaveBeenCalledWith(failure.message, failure.fields);

    clock = 60_000;
    reporter.report({ ...failure, fields: { request: 'task-2', duration: '34ms' } });
    clock = 4 * 60_000;
    reporter.report({ ...failure, fields: { request: 'task-3', duration: '56ms' } });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    clock = 5 * 60_000;
    reporter.report({ ...failure, fields: { request: 'task-4', duration: '78ms' } });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(failure.message, { repeated: 3 });

    reporter.success();
    expect(logger.info).toHaveBeenCalledWith('normal operation resumed after 4 failures');
  });

  it('starts a fresh failure episode after a quiet period', () => {
    const logger = mockLogger();
    let clock = 0;
    const reporter = createFailureReporter(logger, () => clock);
    const failure: FailureReport = {
      key: 'relay',
      message: 'relay request failed: Network down',
      fields: { retryIn: '2s' },
    };

    reporter.report(failure);
    clock = 60_000;
    reporter.report(failure);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    clock = 10 * 60_000;
    reporter.report(failure);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(2, failure.message, { repeated: 1 });
    expect(logger.warn).toHaveBeenNthCalledWith(3, failure.message, failure.fields);
  });

  it('reports suppressed failures when the failure mode changes', () => {
    const logger = mockLogger();
    const reporter = createFailureReporter(logger, () => 0);
    const first: FailureReport = { key: 'relay', message: 'relay request failed: Network down' };
    const second: FailureReport = { key: 'cli.status', message: 'cli.status failed: Forbidden' };

    reporter.report(first);
    reporter.report(first);
    reporter.report(second);

    expect(logger.warn.mock.calls.map(([message, fields]) => [message, fields])).toEqual([
      [first.message, undefined],
      [first.message, { repeated: 1 }],
      [second.message, undefined],
    ]);
    reporter.success();
    expect(logger.info).toHaveBeenCalledWith('normal operation resumed after 3 failures');
  });

  it('bounds flapping failures and announces recovery once', () => {
    const logger = mockLogger();
    const reporter = createFailureReporter(logger, () => 0);
    const failure: FailureReport = { key: 'relay', message: 'relay request failed: Network down' };

    reporter.report(failure);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      reporter.success();
      reporter.report(failure);
    }

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('normal operation resumed after 1 failure');
  });
});
