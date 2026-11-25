import { useInventoryActions } from '../lib/inventoryActions.tsx';
import { EmptyState, ErrorState, LoadingState } from './DataStates.tsx';
import { Button } from './ui/index.ts';

/** One recovery path for every view that needs an org before it can render. */
export function NoOrgState() {
  const actions = useInventoryActions();
  const orgRecovery = actions ? (
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
    return <LoadingState label="Checking for Salesforce orgs..." />;
  }
  if (actions?.orgList.status === 'error') {
    const needsConnection = actions.orgList.recovery === 'connect';
    const errorActions = (
      <div className="flex flex-wrap justify-center gap-2">
        {needsConnection ? (
          <Button variant="primary" onClick={actions.onGoToOrgs}>Go to Org Connections</Button>
        ) : null}
        {actions.mode === 'live' ? (
          <Button variant="secondary" onClick={actions.onToggleMode} disabled={actions.isTogglingMode}>
            Use demo mode
          </Button>
        ) : null}
      </div>
    );

    return (
      <ErrorState
        title="Couldn't check for Salesforce orgs"
        message={actions.orgList.message}
        hint={actions.orgList.hint}
        onRetry={needsConnection ? undefined : actions.orgList.retry}
        retryLabel="Retry org check"
        secondary={errorActions}
      />
    );
  }

  return (
    <EmptyState
      icon="plug"
      title="No org selected"
      description="Choose an authenticated Salesforce org to load its inventory, or use demo mode to explore sample metadata."
      action={orgRecovery}
    />
  );
}
