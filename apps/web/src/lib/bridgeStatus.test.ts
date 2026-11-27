import { describe, expect, it } from 'vitest';
import type { BridgeStatus } from '@dcat/core';
import { bridgeLastSeenText, bridgeLastSeenTitle, bridgeStatusPollIntervalMs } from './bridgeStatus.ts';

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    paired: true,
    mode: 'live',
    version: '0.1.0',
    cli: { installed: true, version: '2.116.6', error: null },
    lastSeenAt: '2026-11-27T12:00:00.000Z',
    relay: 'connected',
    working: false,
    canRepairPairing: false,
    pairing: null,
    agentVersion: '0.2.2',
    latestVersion: null,
    updateAvailable: false,
    selfUpdateSupported: true,
    compatibility: null,
    ...overrides,
  };
}

describe('bridge status display helpers', () => {
  it('polls quickly before pairing and while working, slowly when healthy', () => {
    expect(bridgeStatusPollIntervalMs(undefined)).toBe(5_000);
    expect(bridgeStatusPollIntervalMs(status({ paired: false }))).toBe(5_000);
    expect(bridgeStatusPollIntervalMs(status({ relay: 'working', working: true }))).toBe(5_000);
    expect(bridgeStatusPollIntervalMs(status())).toBe(60_000);
    expect(bridgeStatusPollIntervalMs(status({ cli: { installed: false, version: null, error: null } }))).toBe(10_000);
  });

  it('labels the last check-in only when the state needs explaining', () => {
    const now = Date.parse('2026-11-27T12:02:00.000Z');
    expect(bridgeLastSeenText(status(), now)).toBeNull();
    expect(bridgeLastSeenText(status({ paired: false }), now)).toBeNull();
    const stale = status({ relay: 'stale' });
    expect(bridgeLastSeenText(stale, now)).toBe('Last check-in 2 min ago');
    expect(bridgeLastSeenTitle(stale)).toContain('2026');
  });
});
