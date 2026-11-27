import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type {
  ApiCapability,
  CliStatus,
  DiscoveryProgress,
  FamilyProgress,
  InventorySnapshot,
  OrgSummary,
  RelayOperation,
  RelayRequestState,
  ResourceFamily,
} from '@dcat/core';
import { RESOURCE_FAMILIES } from '@dcat/core';
import { demoInventory, demoOrgs, demoTransformBundles } from '@dcat/test-fixtures';

declare global {
  interface Window {
    __dcatBridgeStop?: boolean;
    __dcatBridgeHold?: boolean;
  }
}

type Mode = 'demo' | 'live';

interface RequestRecord {
  id: string;
  operation: RelayOperation;
  status: RelayRequestState['status'];
  result: unknown;
  error: { code: string; message: string } | null;
  createdAt: number;
}

interface HostedState {
  mode: Mode;
  paired: boolean;
  agentToken: string | null;
  pairingCode: string | null;
  pairingUsed: boolean;
  cli: CliStatus;
  agentVersion: string | null;
  latestVersion: string;
  statusUnavailable: boolean;
  lastSeenAt: number | null;
  request: RequestRecord | null;
  orgs: OrgSummary[];
  inventories: Record<string, InventorySnapshot>;
  /** Optional scripted progressive load; each status poll returns the next snapshot. */
  inventorySequence?: InventorySnapshot[];
  inventoryStep: number;
  operations: RelayOperation[];
  operationBodies: RelayOperation[];
  pairCalls: number;
  pollCalls: number;
  respondCalls: number;
  statusChecks: number;
  authCalls: string[];
  csrf: Record<string, number>;
  requestCounter: number;
}

const token = 'e2e-session-token';
const agentToken = 'agent-token-1234567890';

const FAMILY_FIELDS = {
  'data-spaces': 'dataSpaces',
  dlos: 'dlos',
  dmos: 'dmos',
  mappings: 'mappings',
  'data-streams': 'dataStreams',
  'data-transforms': 'dataTransforms',
} as const satisfies Record<ResourceFamily, keyof InventorySnapshot>;

function liveInventory(org: OrgSummary, label: string): InventorySnapshot {
  return {
    ...structuredClone(demoInventory),
    org,
    mode: 'live',
    dlos: demoInventory.dlos.map((object, index) => (index === 0 ? { ...object, label } : object)),
  };
}

/** Six cumulative snapshots so a hosted load must poll until every family settles. */
function progressiveInventorySnapshots(org: OrgSummary, label: string): InventorySnapshot[] {
  const complete = liveInventory(org, label);
  const counts = new Map<ResourceFamily, number>(
    RESOURCE_FAMILIES.map((family) => [family, (complete[FAMILY_FIELDS[family]] as readonly unknown[]).length]),
  );
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return RESOURCE_FAMILIES.map((family, index) => {
    const loadedFamilies = RESOURCE_FAMILIES.slice(0, index + 1);
    const final = index === RESOURCE_FAMILIES.length - 1;
    const snapshot = structuredClone(complete);
    snapshot.generatedAt = new Date(Date.parse(complete.generatedAt) + index * 1_000).toISOString();
    for (const entry of RESOURCE_FAMILIES) {
      if (!loadedFamilies.includes(entry)) {
        (snapshot[FAMILY_FIELDS[entry]] as unknown[]).length = 0;
      }
    }
    snapshot.capabilities = RESOURCE_FAMILIES.map((entry): ApiCapability => {
      const loaded = counts.get(entry) ?? 0;
      const base = complete.capabilities.find((capability) => capability.family === entry)!;
      const started = loadedFamilies.includes(entry);
      return {
        ...base,
        status: started ? 'available' : 'not-started',
        message: started ? base.message : 'Not started.',
        itemCount: started ? loaded : 0,
        durationMs: started ? base.durationMs : null,
      };
    });
    const families: FamilyProgress[] = RESOURCE_FAMILIES.map((entry, position) => {
      const count = counts.get(entry) ?? 0;
      const loaded = final || position <= index;
      const active = !final && position === index;
      return {
        family: entry,
        status: active ? 'running' : loaded ? 'complete' : 'not-started',
        loaded: loaded ? count : 0,
        total: count,
        expectedTotal: count,
        expectedTotalSource: 'preflight',
        pagesFetched: loaded ? 1 : 0,
        hasMore: active,
        error: null,
        errorStatus: null,
      };
    });
    snapshot.progress = {
      sessionId: `e2e-${org.alias}`,
      generation: 'e2e-generation',
      state: final ? 'complete' : 'running',
      loaded: families.reduce((sum, entry) => sum + entry.loaded, 0),
      total,
      families,
      message: final ? 'Discovery complete.' : 'Loading metadata in small batches.',
    };
    return snapshot;
  });
}

function prodOrgFixture(): OrgSummary {
  return {
    ...demoOrgs[0]!,
    alias: 'prod-org',
    username: 'architect@prod.example.invalid',
    instanceUrl: 'https://prod-org.my.salesforce.com',
    orgId: '00DXX0000001PROD',
    environment: 'production',
    source: 'salesforce-cli',
  };
}

function createState(mode: Mode): HostedState {
  const prodOrg = prodOrgFixture();
  return {
    mode,
    paired: false,
    agentToken: null,
    pairingCode: null,
    pairingUsed: false,
    cli: { installed: false, version: null, error: null },
    agentVersion: null,
    latestVersion: '0.1.3',
    statusUnavailable: false,
    lastSeenAt: null,
    request: null,
    orgs: [],
    inventories: {
      'prod-org': liveInventory(prodOrg, 'Production Account'),
    },
    inventoryStep: 0,
    operations: [],
    operationBodies: [],
    pairCalls: 0,
    pollCalls: 0,
    respondCalls: 0,
    statusChecks: 0,
    authCalls: [],
    csrf: {},
    requestCounter: 0,
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, json: body });
}

function bodyOf(route: Route): Record<string, unknown> {
  try {
    return (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function csrfPath(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith('/api/relay/requests/') ? '/api/relay/requests/:id' : path;
}

function noteCsrf(state: HostedState, route: Route): void {
  const path = csrfPath(route.request().url());
  if (route.request().headers()['x-dcat-token'] === token) {
    state.csrf[path] = (state.csrf[path] ?? 0) + 1;
  }
}

function requestState(record: RequestRecord): RelayRequestState {
  return {
    id: record.id,
    status: record.status,
    result: record.result,
    error: record.error,
  };
}

function compareVersions(left: string | null, right: string | null): number {
  const leftMatch = left?.match(/^(\d+)\.(\d+)\.(\d+)/);
  const rightMatch = right?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!leftMatch || !rightMatch) return Number.NaN;
  for (let index = 1; index <= 3; index += 1) {
    const first = Number(leftMatch[index]);
    const second = Number(rightMatch[index]);
    if (first > second) return 1;
    if (first < second) return -1;
  }
  return 0;
}

function isNewerVersion(latest: string, current: string | null): boolean {
  return compareVersions(latest, current) > 0;
}

function supportsSelfUpdate(current: string | null): boolean {
  return compareVersions(current, '0.1.4') >= 0;
}

function bridgeStatus(state: HostedState, origin: string) {
  const stale = state.lastSeenAt !== null && Date.now() - state.lastSeenAt > 2 * 60_000;
  const working = state.request?.status === 'running';
  return {
    paired: state.paired,
    mode: state.mode,
    version: '0.1.0',
    cli: state.cli,
    lastSeenAt: state.lastSeenAt === null ? null : new Date(state.lastSeenAt).toISOString(),
    relay: state.paired && state.statusUnavailable
      ? 'unavailable'
      : working ? 'working'
        : !state.paired || state.lastSeenAt === null ? 'waiting' : stale ? 'stale' : 'connected',
    working,
    canRepairPairing: state.paired && state.statusUnavailable,
    agentVersion: state.agentVersion,
    latestVersion: state.latestVersion,
    updateAvailable: isNewerVersion(state.latestVersion, state.agentVersion),
    selfUpdateSupported: supportsSelfUpdate(state.agentVersion),
    pairing: state.pairingCode
      ? {
          code: state.pairingCode,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          installCommand: `npx -y @dcat-toolkit/bridge@latest setup --relay ${origin} --code ${state.pairingCode}`,
        }
      : null,
  };
}

function resultFor(state: HostedState, operation: RelayOperation): unknown {
  switch (operation.operation) {
    case 'cli.status':
      return state.cli;
    case 'org.list':
      return state.orgs;
    case 'org.connect': {
      const instanceUrl = typeof operation.instanceUrl === 'string'
        ? operation.instanceUrl
        : 'https://prod-org.my.salesforce.com';
      const environment: OrgSummary['environment'] =
        /sandbox\.my\.salesforce\.com|test\.salesforce\.com/.test(instanceUrl) ? 'sandbox' : 'production';
      const org: OrgSummary = {
        ...demoOrgs[0]!,
        alias: operation.alias,
        username: 'architect@prod.example.invalid',
        instanceUrl,
        orgId: '00DXX0000001PROD',
        environment,
        connectedStatus: 'Connected',
        isDefault: true,
        source: 'salesforce-cli',
      };
      if (!state.orgs.some((entry) => entry.alias === org.alias)) state.orgs = [...state.orgs, org];
      return org;
    }
    case 'inventory.get':
      return state.inventories[operation.alias] ?? liveInventory(demoOrgs[0]!, 'Live Account DLO');
    case 'inventory.start': {
      const scripted = state.inventorySequence?.[0];
      const snapshot = scripted ?? state.inventories[operation.alias] ?? liveInventory(demoOrgs[0]!, 'Live Account DLO');
      state.inventories[operation.alias] = snapshot;
      return {
        sessionId: scripted?.progress?.sessionId ?? `e2e-${operation.alias}`,
        snapshot,
      };
    }
    case 'inventory.status': {
      const lastIndex = (state.inventorySequence?.length ?? 1) - 1;
      state.inventoryStep = Math.min(state.inventoryStep + 1, lastIndex);
      const scripted = state.inventorySequence?.[state.inventoryStep];
      const snapshot = scripted ?? state.inventories[operation.alias] ?? liveInventory(demoOrgs[0]!, 'Live Account DLO');
      state.inventories[operation.alias] = snapshot;
      return {
        sessionId: operation.sessionId ?? snapshot.progress?.sessionId ?? `e2e-${operation.alias}`,
        snapshot,
      };
    }
    case 'transform.get': {
      const bundle = demoTransformBundles[operation.id];
      if (!bundle) throw new Error(`Unknown transform fixture: ${operation.id}`);
      return bundle;
    }
    case 'mode.set':
      state.mode = operation.mode;
      return { mode: operation.mode };
    case 'bridge.update':
      return { updated: true, restarting: true, message: 'Bridge updated and restarting.' };
  }
}

/** Mock Worker session, fixtures, and relay endpoints with an in-page outbound agent. */
async function mockHostedWorker(page: Page, state: HostedState): Promise<void> {
  await page.route(/\/api\/session(?:\?|$)/, (route) =>
    json(route, { token, mode: state.mode }),
  );

  await page.route(/\/api\/mode(?:\?|$)/, async (route) => {
    if (route.request().method() === 'POST') {
      const body = bodyOf(route);
      if (body.mode === 'demo' || body.mode === 'live') state.mode = body.mode;
    }
    await json(route, { mode: state.mode });
  });

  await page.route(/\/api\/orgs(?:\/|\?|$)/, async (route) => {
    const segments = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (segments.length === 2) return json(route, demoOrgs);
    const alias = decodeURIComponent(segments[2] ?? '');
    if (segments[3] === 'data-transforms' && segments[4]) {
      const bundle = demoTransformBundles[decodeURIComponent(segments[4])];
      return bundle
        ? json(route, bundle)
        : json(route, { error: { code: 'TRANSFORM_NOT_FOUND', message: 'Unknown transform' } }, 404);
    }
    if (segments[3] === 'inventory') {
      const inventory = state.mode === 'demo' ? demoInventory : state.inventories[alias] ?? demoInventory;
      if (segments[4] === 'session') {
        return json(route, { sessionId: segments[5] ?? 'e2e-session', snapshot: inventory });
      }
      return json(route, inventory);
    }
    const org = demoOrgs.find((entry) => entry.alias === alias);
    return org
      ? json(route, org)
      : json(route, { error: { code: 'ORG_NOT_FOUND', message: 'Unknown org' } }, 404);
  });

  await page.route(/\/api\/relay(?:\/|$)/, async (route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    const method = route.request().method();
    noteCsrf(state, route);

    if ((path === '/api/relay/status' || path === '/api/relay/status/check') && method === 'GET') {
      if (path === '/api/relay/status/check') state.statusChecks += 1;
      return json(route, bridgeStatus(state, new URL(url).origin));
    }

    if (path === '/api/relay/pairing' && method === 'POST') {
      if (route.request().headers()['x-dcat-token'] !== token) {
        return json(route, { error: { code: 'INVALID_SESSION_TOKEN', message: 'Refresh the page.' } }, 401);
      }
      if (state.paired && !state.statusUnavailable) {
        return json(route, { error: { code: 'BRIDGE_ALREADY_PAIRED', message: 'Already paired.' } }, 409);
      }
      if (state.paired) {
        state.paired = false;
        state.agentToken = null;
        state.pairingCode = null;
        state.lastSeenAt = null;
        state.statusUnavailable = false;
      }
      state.pairingCode ??= 'PAIR12345678';
      return json(route, bridgeStatus(state, new URL(url).origin).pairing);
    }

    if (path === '/api/relay/pair' && method === 'POST') {
      const body = bodyOf(route);
      if (state.pairingUsed || body.code !== state.pairingCode) {
        return json(route, { error: { code: 'INVALID_PAIRING_CODE', message: 'Code is invalid or expired.' } }, 400);
      }
      state.pairCalls += 1;
      state.pairingUsed = true;
      state.paired = true;
      state.agentToken = agentToken;
      state.pairingCode = null;
      state.statusUnavailable = false;
      state.lastSeenAt = null;
      if (body.cli && typeof body.cli === 'object') state.cli = body.cli as CliStatus;
      if (typeof body.version === 'string') state.agentVersion = body.version;
      return json(route, { agentToken });
    }

    if (path === '/api/relay/poll' && method === 'POST') {
      const body = bodyOf(route);
      if (body.agentToken !== state.agentToken) {
        return json(route, { error: { code: 'INVALID_AGENT_TOKEN', message: 'Pairing reset.' } }, 401);
      }
      state.pollCalls += 1;
      state.lastSeenAt = Date.now();
      if (body.cli && typeof body.cli === 'object') state.cli = body.cli as CliStatus;
      if (typeof body.version === 'string') state.agentVersion = body.version;
      const tasks = state.request?.status === 'pending'
        ? [{
            id: state.request.id,
            operation: state.request.operation,
            createdAt: new Date(state.request.createdAt).toISOString(),
          }]
        : [];
      if (state.request?.status === 'pending') state.request.status = 'running';
      return json(route, { status: 'ok', tasks });
    }

    if (path === '/api/relay/respond' && method === 'POST') {
      const body = bodyOf(route);
      if (body.agentToken !== state.agentToken) {
        return json(route, { error: { code: 'INVALID_AGENT_TOKEN', message: 'Pairing reset.' } }, 401);
      }
      state.respondCalls += 1;
      const response = body.response as { id?: string; ok?: boolean; error?: { code: string; message: string } };
      const record = state.request;
      if (!record || record.id !== response.id) {
        return json(route, { error: { code: 'NOT_FOUND', message: 'Unknown request.' } }, 404);
      }
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'expired') {
        return json(route, { ok: true });
      }
      if (response.ok === false) {
        record.status = 'failed';
        record.error = response.error ?? { code: 'RELAY_FAILED', message: 'Bridge request failed.' };
      } else {
        record.status = 'completed';
        record.result = resultFor(state, record.operation);
        record.error = null;
      }
      return json(route, { ok: true });
    }

    if (path === '/api/relay/requests' && method === 'POST') {
      if (route.request().headers()['x-dcat-token'] !== token) {
        return json(route, { error: { code: 'INVALID_SESSION_TOKEN', message: 'Refresh the page.' } }, 401);
      }
      const operation = bodyOf(route) as unknown as RelayOperation;
      if (typeof operation?.operation !== 'string') {
        return json(route, { error: { code: 'INVALID_ARGUMENT', message: 'Unsupported operation.' } }, 400);
      }
      state.operations.push(operation);
      state.operationBodies.push(operation);
      if (!state.paired) {
        return json(route, { error: { code: 'BRIDGE_NOT_CONNECTED', message: 'Set up SF CLI first.' } }, 409);
      }
      if (state.request && (state.request.status === 'pending' || state.request.status === 'running')) {
        return json(route, { error: { code: 'BRIDGE_BUSY', message: 'Wait for the current request.' } }, 409);
      }
      state.requestCounter += 1;
      state.request = {
        id: `req-${state.requestCounter}`,
        operation,
        status: 'pending',
        result: null,
        error: null,
        createdAt: Date.now(),
      };
      return json(route, { id: state.request.id, status: 'pending' });
    }

    const requestMatch = /^\/api\/relay\/requests\/([^/]+)$/.exec(path);
    if (requestMatch && method === 'GET') {
      if (route.request().headers()['x-dcat-token'] !== token) {
        return json(route, { error: { code: 'INVALID_SESSION_TOKEN', message: 'Refresh the page.' } }, 401);
      }
      const record = state.request;
      if (!record || record.id !== decodeURIComponent(requestMatch[1] ?? '')) {
        return json(route, { error: { code: 'NOT_FOUND', message: 'Request not found.' } }, 404);
      }
      return json(route, requestState(record));
    }

    if (path === '/api/relay/unpair' && method === 'POST') {
      state.paired = false;
      state.agentToken = null;
      state.pairingCode = null;
      state.pairingUsed = false;
      state.statusUnavailable = false;
      state.lastSeenAt = null;
      state.cli = { installed: false, version: null, error: null };
      state.agentVersion = null;
      state.request = null;
      return json(route, { paired: false });
    }

    return json(route, { error: { code: 'NOT_FOUND', message: 'Unknown relay endpoint.' } }, 404);
  });

  await page.route(/\/api\/auth(?:\/|$)/, async (route) => {
    state.authCalls.push(new URL(route.request().url()).pathname);
    await json(route, { error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
  });
}

async function seedPreference(page: Page, mode: Mode): Promise<void> {
  await page.addInitScript((preferred) => {
    try {
      window.localStorage.setItem('dcat.mode', preferred);
      window.localStorage.setItem('dcat.theme', 'light');
    } catch {
      // Preferences are optional; the mocked session still supplies the mode.
    }
  }, mode);
}

function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Stand-in for the installed agent: pair once, then poll and answer typed tasks. */
async function startFakeBridge(page: Page, pairingCode: string): Promise<void> {
  await page.evaluate(async (code) => {
    const pair = await fetch('/api/relay/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        version: '0.1.4',
        cli: { installed: true, version: '2.116.6', error: null },
      }),
    });
    if (!pair.ok) throw new Error(`Pairing failed with status ${pair.status}`);
    const { agentToken: token } = (await pair.json()) as { agentToken: string };
    const bridge = window as Window & { __dcatBridgeStop?: boolean };
    bridge.__dcatBridgeStop = false;

    const loop = async () => {
      while (!bridge.__dcatBridgeStop) {
        const poll = await fetch('/api/relay/poll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentToken: token,
            version: '0.1.4',
            cli: { installed: true, version: '2.116.6', error: null },
          }),
        });
        if (!poll.ok) return;
        const payload = (await poll.json()) as { tasks?: Array<{ id: string; operation?: RelayOperation }> };
        for (const task of payload.tasks ?? []) {
          while (bridge.__dcatBridgeHold) {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          }
          const result = task.operation?.operation === 'bridge.update'
            ? { updated: true, restarting: true, message: 'Bridge updated and restarting.' }
            : {};
          await fetch('/api/relay/respond', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentToken: token,
              response: { id: task.id, ok: true, result },
            }),
          });
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    };
    void loop();
  }, pairingCode);
}

test('hosted bridge pairs, connects an org, waits for every inventory family, and ends cleanly', async ({ page }) => {
  const state = createState('live');
  state.inventorySequence = progressiveInventorySnapshots(prodOrgFixture(), 'Production Account');
  const pageErrors = watchPageErrors(page);
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Set up SF CLI' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create pairing code' })).toBeVisible();

  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await expect(page.getByText('PAIR12345678', { exact: true })).toBeVisible();
  await expect(page.getByText(
    `npx -y @dcat-toolkit/bridge@latest setup --relay ${new URL(page.url()).origin} --code PAIR12345678`,
  )).toBeVisible();

  await startFakeBridge(page, 'PAIR12345678');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('Bridge connected')).toBeVisible();
  expect(state.statusChecks).toBeGreaterThan(0);

  await page.getByLabel('Org alias').fill('prod-org');
  await page.getByRole('button', { name: 'Connect org' }).click();

  await expect(page.locator('h1')).toHaveText('Dashboard');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('Live org metadata')).toBeVisible();
  await expect(page.getByTestId('inventory-progress')).toContainText('Loading inventory in batches');
  await expect(page.getByTestId('inventory-progress')).toContainText('Inventory complete', { timeout: 20_000 });
  await expect(page.getByRole('img', { name: 'Inventory still loading' })).toHaveCount(0);
  await expect(page.getByTestId('inventory-progress')).not.toContainText('more to load');
  await expect(page.getByTestId('inventory-progress')).not.toContainText('stopped');
  await expect(page.locator('#main-content').getByTestId('inventory-freshness')).toBeVisible();

  expect(state.pairCalls).toBe(1);
  expect(state.pollCalls).toBeGreaterThan(0);
  expect(state.respondCalls).toBeGreaterThanOrEqual(2);
  expect(state.operations.map((operation) => operation.operation)).toEqual(
    expect.arrayContaining(['org.list', 'org.connect', 'inventory.start']),
  );
  expect(state.operationBodies).toContainEqual({ operation: 'org.connect', alias: 'prod-org' });
  expect(state.operationBodies).toContainEqual({ operation: 'inventory.start', alias: 'prod-org' });

  // Connecting must feed the selection directly; a fresh `org.list` must not
  // become a blocking step before the dashboard can start its inventory load.
  const connectIndex = state.operations.findIndex((operation) => operation.operation === 'org.connect');
  const inventoryIndex = state.operations.findIndex((operation) => operation.operation === 'inventory.start');
  const operationNames = state.operations.map((operation) => operation.operation).join(', ');
  expect(connectIndex, `operations: ${operationNames}`).toBeGreaterThanOrEqual(0);
  expect(inventoryIndex, `operations: ${operationNames}`).toBe(connectIndex + 1);
  expect(state.operations.slice(connectIndex + 1).some((operation) => operation.operation === 'org.list')).toBe(false);

  // Every status poll must stay on the connected alias and the session it started.
  const inventoryOperations = state.operations.filter(
    (operation): operation is Extract<RelayOperation, { operation: 'inventory.start' | 'inventory.status' }> =>
      operation.operation === 'inventory.start' || operation.operation === 'inventory.status',
  );
  const statusOperations = inventoryOperations.filter((operation) => operation.operation === 'inventory.status');
  expect(statusOperations.length).toBeGreaterThan(0);
  expect(inventoryOperations.every((operation) => operation.alias === 'prod-org')).toBe(true);
  expect(statusOperations.every((operation) => operation.sessionId === 'e2e-prod-org')).toBe(true);
  expect(state.operationBodies).toContainEqual({
    operation: 'inventory.status',
    alias: 'prod-org',
    sessionId: 'e2e-prod-org',
    resume: false,
  });
  expect(state.request?.status).toBe('completed');
  expect(state.request?.error).toBeNull();
  const finalResult = state.request?.result as { sessionId?: string; snapshot?: InventorySnapshot } | null | undefined;
  expect(finalResult?.sessionId).toBe('e2e-prod-org');
  expect(finalResult?.snapshot?.org.alias).toBe('prod-org');
  expect(finalResult?.snapshot?.progress?.state).toBe('complete');
  expect(finalResult?.snapshot?.progress?.families.every((family) =>
    family.status === 'complete' && !family.hasMore && family.error === null)).toBe(true);

  expect(state.csrf['/api/relay/pairing']).toBeGreaterThan(0);
  expect(state.csrf['/api/relay/requests']).toBeGreaterThan(0);
  expect(state.csrf['/api/relay/requests/:id']).toBeGreaterThan(0);
  expect(state.authCalls).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(pageErrors).toEqual([]);

  await page.evaluate(() => {
    (window as Window & { __dcatBridgeStop?: boolean }).__dcatBridgeStop = true;
  });
});

test('hosted refresh status reports a long operation without queuing relay work', async ({ page }) => {
  const state = createState('live');
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await startFakeBridge(page, 'PAIR12345678');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('Bridge connected')).toBeVisible();
  // Pairing can trigger one setup check. Let it drain before queueing the
  // long operation so BRIDGE_BUSY is not mistaken for a refresh-status bug.
  await expect.poll(() => state.request?.status).toBe('completed');

  await page.evaluate(() => {
    window.__dcatBridgeHold = true;
  });
  await page.evaluate(async (sessionToken) => {
    const response = await fetch('/api/relay/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dcat-token': sessionToken },
      body: JSON.stringify({ operation: 'org.connect', alias: 'prod-org' }),
    });
    if (!response.ok) throw new Error(`Could not start long operation: ${response.status}`);
  }, token);
  await expect.poll(async () => state.request?.status).toBe('running');

  const operationsBeforeRefresh = [...state.operations];
  const checksBeforeRefresh = state.statusChecks;
  await page.getByRole('button', { name: 'Refresh status' }).click();

  await expect(page.getByText('The bridge is running a long operation.')).toBeVisible();
  await expect(page.getByText(
    'It will check in again when it finishes. The API version stays unchanged until then.',
  )).toBeVisible();
  expect(state.statusChecks).toBeGreaterThan(checksBeforeRefresh);
  expect(state.operations).toEqual(operationsBeforeRefresh);

  await page.evaluate(() => {
    window.__dcatBridgeHold = false;
    window.__dcatBridgeStop = true;
  });
});

test('hosted setup before pairing does not report a CLI or org failure', async ({ page }) => {
  const state = createState('live');
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  // The real Worker rejects org.list before pairing; reproduce that response.
  await page.route(/\/api\/orgs(?:\/|\?|$)/, (route) =>
    json(route, { error: { code: 'BRIDGE_NOT_CONNECTED', message: 'Set up SF CLI first.' } }, 409));
  await page.goto('/orgs');

  await expect(page.getByRole('heading', { name: 'Set up SF CLI' })).toBeVisible();
  await expect(page.getByText('Bridge not paired')).toBeVisible();
  await expect(page.getByText('SF CLI missing')).toHaveCount(0);
  await expect(page.getByText("Couldn't check for Salesforce orgs")).toHaveCount(0);
  await expect(page.getByText('The bridge is not connected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry org check' })).toHaveCount(0);
  await expect(page.getByText('Complete steps 1 and 2 first')).toBeVisible();
});

test('hosted demo to live with an unpaired bridge does not report an org failure', async ({ page }) => {
  const state = createState('demo');
  await seedPreference(page, 'demo');
  await mockHostedWorker(page, state);
  await page.route(/\/api\/orgs(?:\/|\?|$)/, async (route) => {
    const segments = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (segments.length === 2 && state.mode === 'live' && !state.paired) {
      await json(route, { error: { code: 'BRIDGE_NOT_CONNECTED', message: 'Set up SF CLI first.' } }, 409);
      return;
    }
    await route.fallback();
  });
  await page.goto('/');

  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toBeVisible();
  await page.locator('header').getByRole('button', { name: 'Switch to live mode' }).click();
  await expect(page.locator('header').getByRole('button', { name: 'Switch to demo mode' })).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();

  await expect(page.getByRole('heading', { name: 'Set up SF CLI' })).toBeVisible();
  await expect(page.getByText('Bridge not paired')).toBeVisible();
  await expect(page.getByText("Couldn't check for Salesforce orgs")).toHaveCount(0);
  await expect(page.getByText('The bridge is not connected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry org check' })).toHaveCount(0);
});

test('hosted pairing outside setup updates the root org gate', async ({ page }) => {
  const state = createState('live');
  state.orgs = [{ ...demoOrgs[0]!, alias: 'paired-org', source: 'salesforce-cli' }];
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.route(/\/api\/orgs(?:\/|\?|$)/, async (route) => {
    const segments = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (segments.length === 2 && !state.paired) {
      await json(route, { error: { code: 'BRIDGE_NOT_CONNECTED', message: 'Set up SF CLI first.' } }, 409);
      return;
    }
    await route.fallback();
  });
  await page.goto('/orgs');

  await expect(page.getByRole('heading', { name: 'Set up SF CLI' })).toBeVisible();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Dashboard' }).click();
  await startFakeBridge(page, 'PAIR12345678');

  await expect(page.locator('header select option[value="paired-org"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText("Couldn't check for Salesforce orgs")).toHaveCount(0);
  await page.evaluate(() => {
    (window as Window & { __dcatBridgeStop?: boolean }).__dcatBridgeStop = true;
  });
});

test('hosted connect detects a sandbox from its Salesforce instance URL', async ({ page }) => {
  const state = createState('live');
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await startFakeBridge(page, 'PAIR12345678');
  await page.getByRole('button', { name: 'Refresh status' }).click();

  await page.getByLabel('Org alias').fill('uat-org');
  await page.getByLabel(/Sandbox instance URL/).fill('https://acme--uat.sandbox.my.salesforce.com');
  await page.getByRole('button', { name: 'Connect org' }).click();

  await expect(page.locator('h1')).toHaveText('Dashboard');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();

  const row = page.getByRole('row', { name: /uat-org/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('sandbox');
  expect(state.operationBodies).toContainEqual({
    operation: 'org.connect',
    alias: 'uat-org',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
  });

  await page.evaluate(() => {
    (window as Window & { __dcatBridgeStop?: boolean }).__dcatBridgeStop = true;
  });
});

test('hosted connect recovers from an unavailable relay with a fresh pairing command', async ({ page }) => {
  const state = createState('live');
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await startFakeBridge(page, 'PAIR12345678');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('Bridge connected')).toBeVisible();

  state.statusUnavailable = true;
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('Bridge status is temporarily unavailable.')).toBeVisible();

  await page.getByRole('button', { name: 'Create new pairing code' }).click();
  await expect(page.getByText('PAIR12345678', { exact: true })).toBeVisible();
  await expect(page.getByText(
    `npx -y @dcat-toolkit/bridge@latest setup --relay ${new URL(page.url()).origin} --code PAIR12345678`,
  )).toBeVisible();

  await page.evaluate(() => {
    (window as Window & { __dcatBridgeStop?: boolean }).__dcatBridgeStop = true;
  });
});

test('hosted bridge update guidance offers a copyable command without queuing a relay task', async ({ page }) => {
  const state = createState('live');
  state.latestVersion = '0.1.5';
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await startFakeBridge(page, 'PAIR12345678');
  await page.getByRole('button', { name: 'Refresh status' }).click();

  await expect(page.getByText(/Bridge update available · 0\.1\.5/)).toBeVisible();
  await expect(page.getByText(/Running 0\.1\.4/)).toBeVisible();
  await expect(page.getByText('npm install -g @dcat-toolkit/bridge@latest')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update bridge' })).toHaveCount(0);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();
  const versionFact = page.locator('dt').filter({ hasText: 'Bridge version' }).locator('..');
  await expect(versionFact).toContainText('0.1.4');
  await expect(versionFact).not.toContainText('0.1.0');

  expect(state.operationBodies.some((operation) => operation.operation === 'bridge.update')).toBe(false);
  expect(state.authCalls).toEqual([]);
  expect(state.operations.some((operation) => operation.operation === 'shell.exec')).toBe(false);

  await page.evaluate(() => {
    (window as Window & { __dcatBridgeStop?: boolean }).__dcatBridgeStop = true;
  });
});

test('hosted offline bridge shows one recovery step instead of competing update guidance', async ({ page }) => {
  const state = createState('live');
  state.paired = true;
  state.agentToken = agentToken;
  state.cli = { installed: true, version: '2.116.6', error: null };
  state.agentVersion = '0.1.4';
  state.latestVersion = '0.1.5';
  state.lastSeenAt = Date.now() - 3 * 60_000;
  await seedPreference(page, 'live');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();

  await expect(page.getByText('The bridge stopped responding.')).toBeVisible();
  await expect(page.getByText(/Bridge update available/)).toHaveCount(0);
  await expect(page.getByText('npm install -g @dcat-toolkit/bridge@latest')).toHaveCount(0);
  await expect(page.getByText('npx -y @dcat-toolkit/bridge@latest start')).toBeVisible();
});

test('hosted demo stays fixture-backed, labelled, and gap-free', async ({ page }) => {
  const state = createState('demo');
  await seedPreference(page, 'demo');
  await mockHostedWorker(page, state);
  await page.goto('/');

  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toHaveAttribute(
    'title',
    'Sample metadata only - no Salesforce org is connected.',
  );
  await expect(page.getByText('Sample metadata only - no Salesforce org is connected.')).toHaveCount(0);
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.getByText('Inventory loaded with gaps')).toHaveCount(0);
  await expect(page.locator('header').getByText(/^Updated /)).toHaveCount(0);
  await expect(page.locator('#main-content').getByTestId('inventory-freshness')).toBeVisible();

  expect(state.operations).toEqual([]);
  expect(state.pairCalls).toBe(0);
  expect(state.authCalls).toEqual([]);

  await page.goto('/orgs');
  await expect(page.getByText(/Demo mode runs on labelled sample data/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect org' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Re-check CLI' })).toBeDisabled();
  await expect(page.getByText('SF CLI missing')).toHaveCount(0);
  await expect(page.getByText('Complete step 1 first')).toHaveCount(0);
  expect(state.pairCalls).toBe(0);
});
