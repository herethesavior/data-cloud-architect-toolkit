/** Sanitized CLI outputs shaped like the installed Salesforce CLI 2.116.x. */
export const cliVersionOutput = '@salesforce/cli/2.116.6 win32-x64 node-v22.21.1';

const demoOrgEntry = {
  accessToken: '00DDEMOTOKEN_NOT_REAL_DO_NOT_USE_000000000000000000000000',
  instanceUrl: 'https://demo--uat.sandbox.my.salesforce.com',
  orgId: '00DDEMO000000000AAA',
  username: 'architect@demo-uat.example.invalid',
  loginUrl: 'https://test.salesforce.com/',
  clientId: 'PlatformCLI',
  isDevHub: false,
  alias: 'demo-uat',
  isDefaultUsername: true,
  isDefaultDevHubUsername: false,
  lastUsed: '2026-11-17T12:00:00.000Z',
  connectedStatus: 'Connected',
};

export const orgListJson = JSON.stringify({
  status: 0,
  result: {
    other: [],
    nonScratchOrgs: [demoOrgEntry],
    sandboxes: [],
    devHubs: [],
    scratchOrgs: [],
  },
  warnings: [],
});

/** Older/alternate CLI shape kept as an adapter compatibility fixture. */
export const orgListAlternateJson = JSON.stringify({
  status: 0,
  result: {
    nonScratchOrgInfos: [
      {
        ...demoOrgEntry,
        alias: 'demo-alt',
        isDefaultUsername: false,
        loginUrl: 'https://login.salesforce.com/',
        instanceUrl: 'https://demo.my.salesforce.com',
      },
    ],
    scratchOrgInfos: [],
  },
});

export const orgListUnexpectedJson = JSON.stringify({ status: 0, result: { unexpected: [] } });

export const orgDisplayJson = JSON.stringify({
  status: 0,
  result: {
    ...demoOrgEntry,
    id: demoOrgEntry.orgId,
    connectedStatus: 'Connected',
  },
});

export const cliFailureOutput = 'ERROR running org list: authentication has expired';
