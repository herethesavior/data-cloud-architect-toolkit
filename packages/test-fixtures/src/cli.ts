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
  isSandbox: true,
  isScratch: false,
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
        isSandbox: false,
        isScratch: false,
        loginUrl: 'https://login.salesforce.com/',
        instanceUrl: 'https://demo.my.salesforce.com',
      },
    ],
    scratchOrgInfos: [],
  },
});

/** Real CLI metadata shapes for environment detection across org types. */
export const orgListEnvironmentJson = JSON.stringify({
  status: 0,
  result: {
    nonScratchOrgs: [
      {
        alias: 'dev-ed',
        username: 'dev@example.invalid',
        orgId: '00D0000000000DEV',
        instanceUrl: 'https://orgfarm-8e714281c7-dev-ed.develop.my.salesforce.com',
        loginUrl: 'https://orgfarm-8e714281c7-dev-ed.develop.my.salesforce.com/',
        isDevHub: false,
        isSandbox: false,
        isScratch: false,
        connectedStatus: 'Connected',
      },
      {
        alias: 'uat',
        username: 'uat@example.invalid',
        orgId: '00D0000000000UAT',
        instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
        loginUrl: 'https://test.salesforce.com/',
        isDevHub: false,
        isSandbox: true,
        isScratch: false,
        connectedStatus: 'Connected',
      },
      {
        alias: 'hub',
        username: 'hub@example.invalid',
        orgId: '00D0000000000HUB',
        instanceUrl: 'https://acme.my.salesforce.com',
        loginUrl: 'https://login.salesforce.com/',
        isDevHub: true,
        isSandbox: false,
        isScratch: false,
        connectedStatus: 'Connected',
      },
    ],
    scratchOrgs: [
      {
        alias: 'scratch',
        username: 'scratch@example.invalid',
        orgId: '00D0000000000SCR',
        instanceUrl: 'https://acme--scratch.scratch.my.salesforce.com',
        loginUrl: 'https://acme--scratch.scratch.my.salesforce.com/',
        isDevHub: false,
        isSandbox: false,
        isScratch: true,
        connectedStatus: 'Connected',
      },
    ],
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
