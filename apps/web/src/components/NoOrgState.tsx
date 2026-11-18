import { useInventoryActions } from '../lib/inventoryActions.tsx';
import { EmptyState } from './DataStates.tsx';
import { Button } from './ui/index.ts';

/** One recovery path for every view that needs an org before it can render. */
export function NoOrgState() {
  const actions = useInventoryActions();

  return (
    <EmptyState
      icon="plug"
      title="No org selected"
      description="Choose an authenticated Salesforce org to load its inventory, or use demo mode to explore sample metadata."
      action={actions ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={actions.onGoToOrgs}>Select an org</Button>
          {actions.mode === 'live' ? (
            <Button variant="secondary" onClick={actions.onToggleMode} disabled={actions.isTogglingMode}>
              Use demo mode
            </Button>
          ) : null}
        </div>
      ) : undefined}
    />
  );
}
