import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ResourceFamily } from '@dcat/core';
import type { WorkspaceContext } from './workspace.ts';

export type OrgListState =
  | { status: 'checking' }
  | { status: 'error'; message: string; retry: () => void }
  | { status: 'idle' };

export interface InventoryActions {
  context: WorkspaceContext | null;
  mode: 'demo' | 'live';
  orgList: OrgListState;
  onGoToOrgs: () => void;
  onToggleMode: () => void;
  isTogglingMode: boolean;
  refreshInventory: () => void;
  cancelRefresh: () => void;
  isRefreshingInventory: boolean;
  refreshError: string;
  resumeDiscovery?: (family?: ResourceFamily) => void;
  isResumingDiscovery?: boolean;
}

const InventoryActionsContext = createContext<InventoryActions | null>(null);

/** Shared actions so every inventory view can offer the same recovery path. */
export function InventoryActionsProvider({ value, children }: { value: InventoryActions; children: ReactNode }) {
  return <InventoryActionsContext.Provider value={value}>{children}</InventoryActionsContext.Provider>;
}

export function useInventoryActions(): InventoryActions | null {
  return useContext(InventoryActionsContext);
}
