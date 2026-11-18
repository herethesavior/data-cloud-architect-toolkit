import { useInventoryActions } from '../lib/inventoryActions.tsx';
import { EmptyState, ErrorState, LoadingState } from './DataStates.tsx';
import { Button } from './ui/index.ts';

/** One recovery path for every view that needs an org before it can render. */
export function NoOrgState() {
  const actions = useInventoryActions();
  const recovery = actions ? (
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="primary" onClick={actions.onGoToOrgs}>Select an org</Button>
      {actions.mode === 'live' ? (
        <Button variant="secondary" onClick={actions.onToggleMode} disabled={actions.isTogglingMode}>
          Use demo mode
        </Button>
      ) : null}
    </div>
  ) : undefined;

  if (actions?.orgList.status === 'checking') {
    return <LoadingState label="Checking for Salesforce orgs…" action={recovery} />;
  }
  if (actions?.orgList.status === 'error') {
    return (
      <ErrorState
        title="Couldn't check for Salesforce orgs"
        message={actions.orgList.message}
        onRetry={actions.orgList.retry}
        retryLabel="Retry org check"
        secondary={recovery}
      />
    );
  }

  return (
    <EmptyState
      icon="plug"
      title="No org selected"
      description="Choose an authenticated Salesforce org to load its inventory, or use demo mode to explore sample metadata."
      action={recovery}
    />
  );
}
