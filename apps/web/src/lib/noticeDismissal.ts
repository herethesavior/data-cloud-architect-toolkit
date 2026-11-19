import { useEffect, useRef, useSyncExternalStore } from 'react';

interface NoticeState {
  dismissed: Map<string, string>;
  exportEpoch: number;
}

/**
 * Dismissals live for the current page load, not in browser storage. A channel
 * remembers only its latest key, so a changed message always becomes visible
 * again while ordinary navigation keeps a dismissed notice hidden. The store
 * is subscribed so every copy of a notice reacts to the same dismissal.
 */
let state: NoticeState = { dismissed: new Map(), exportEpoch: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useNoticeSelector<T>(selector: (current: NoticeState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function resetNoticeDismissals(): void {
  state = { dismissed: new Map(), exportEpoch: 0 };
  notify();
}

export function markExport(): void {
  state = { ...state, exportEpoch: state.exportEpoch + 1 };
  notify();
}

export function useExportNoticeKey(): string {
  return `export:${useNoticeSelector((current) => current.exportEpoch)}`;
}

function dismissNotice(channel: string, key: string): void {
  const dismissed = new Map(state.dismissed);
  dismissed.set(channel, key);
  state = { ...state, dismissed };
  notify();
}

function clearNotice(channel: string): void {
  if (!state.dismissed.has(channel)) return;
  const dismissed = new Map(state.dismissed);
  dismissed.delete(channel);
  state = { ...state, dismissed };
  notify();
}

export function useDismissibleNotice(channel: string, key: string) {
  const dismissedKey = useNoticeSelector((current) => current.dismissed.get(channel) ?? null);
  const previousKeyRef = useRef(key);

  useEffect(() => {
    if (previousKeyRef.current === key) return;
    previousKeyRef.current = key;
    clearNotice(channel);
  }, [channel, key]);

  return { visible: dismissedKey !== key, dismiss: () => dismissNotice(channel, key) };
}
