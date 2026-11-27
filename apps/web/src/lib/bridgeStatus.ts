import type { BridgeStatus } from '@dcat/core';
import { formatUpdatedAt, safeDateText } from './inventory.ts';

/**
 * Passive status traffic has one cadence. An explicit Refresh status writes a
 * fresh snapshot, so the next poll is measured from that result rather than
 * from a second observer's older timer.
 */
export function bridgeStatusPollIntervalMs(status: BridgeStatus | undefined): number {
  if (!status?.paired || status.relay === 'working') return 5_000;
  if (status.cli.installed && status.relay === 'connected') return 60_000;
  return 10_000;
}

/** A last-check-in label explains a non-connected state without contradicting a healthy one. */
export function bridgeLastSeenText(status: BridgeStatus | undefined, now = Date.now()): string | null {
  if (!status?.paired || !status.lastSeenAt || status.relay === 'connected') return null;
  return `Last check-in ${formatUpdatedAt(status.lastSeenAt, now)}`;
}

export function bridgeLastSeenTitle(status: BridgeStatus | undefined): string | undefined {
  if (!status?.paired || !status.lastSeenAt || status.relay === 'connected') return undefined;
  return `Bridge last checked in ${safeDateText(status.lastSeenAt)}`;
}
