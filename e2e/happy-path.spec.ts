import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { createApiVersionStatus, RESOURCE_FAMILIES } from '@dcat/core';
import type { ApiVersionStatus, InventorySnapshot, OrgSummary } from '@dcat/core';
import { demoInventory, demoOrgs, demoTransformBundles } from '@dcat/test-fixtures';

declare global {
  interface Window {
    __demoAfterSwitch?: boolean;
    __switchObserver?: MutationObserver;
  }
}

const health = {
  status: 'ok',
  mode: 'demo',
  version: '0.1.0',
  time: '2026-11-18T00:00:00.000Z',
  cli: { installed: true, version: '2.116.6', error: null },
};

interface ConnectorState {
  mode: 'demo' | 'live';
  /** Orgs returned when the connector is in live mode. */
  orgs: OrgSummary[];
  inventories: Record<string, InventorySnapshot>;
  compatibility: ApiVersionStatus;
}

function createConnectorState(): ConnectorState {
  const prodOrg: OrgSummary = {
    ...demoOrgs[0]!,
    alias: 'prod-org',
    orgId: '00DXX0000001PROD',
    environment: 'production',
    source: 'salesforce-cli',
  };
  const sandboxOrg: OrgSummary = {
    ...demoOrgs[0]!,
    alias: 'sandbox-org',
    orgId: '00DXX0000002SBX',
    environment: 'sandbox',
    source: 'salesforce-cli',
  };

  const liveInventory = (org: OrgSummary, label: string): InventorySnapshot => ({
    ...structuredClone(demoInventory),
    org,
    mode: 'live',
    dlos: demoInventory.dlos.map((object, index) => (index === 0 ? { ...object, label } : object)),
  });

  return {
    mode: 'demo',
    orgs: [prodOrg, sandboxOrg],
    compatibility: {
      ...createApiVersionStatus(),
      used: '67.0',
      latest: '68.0',
      verifiedAt: '2026-11-18T00:00:00.000Z',
      probeStatus: 'available',
    },
    inventories: {
      'demo-uat': liveInventory(demoOrgs[0]!, 'Live Account DLO'),
      'prod-org': liveInventory(prodOrg, 'Production Account'),
      'sandbox-org': liveInventory(sandboxOrg, 'Sandbox Account'),
    },
  };
}

interface MockConnectorOptions {
  modeDelayMs?: number;
  transformDetailDelayMs?: number;
  modeCalls?: string[];
  calls?: { orgs: number; inventory: number };
  sessionStartBodies?: Array<Record<string, unknown>>;
}

/** Mock connector: no CLI, no real org, deterministic and mode-aware fixtures. */
async function mockConnector(page: Page, state: ConnectorState, options: MockConnectorOptions = {}) {
  await page.route('**/api/session', (route: Route) =>
    route.fulfill({ json: { token: 'e2e-token', mode: state.mode } }),
  );
  await page.route('**/api/mode', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { mode?: string };
      options.modeCalls?.push(body.mode ?? '');
      if (body.mode === 'demo' || body.mode === 'live') state.mode = body.mode;
    }
    if (options.modeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.modeDelayMs));
    await route.fulfill({ json: { mode: state.mode } });
  });
  await page.route('**/api/health', (route: Route) =>
    route.fulfill({ json: { ...health, mode: state.mode, compatibility: state.compatibility } }),
  );
  await page.route('**/api/compatibility', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const selection = route.request().postDataJSON() as ApiVersionStatus['selection'];
      state.compatibility = {
        ...createApiVersionStatus(selection),
        used: selection.mode === 'specific' ? selection.version : '68.0',
        latest: '68.0',
      };
    }
    await route.fulfill({ json: state.compatibility });
  });
  await page.route('**/api/cli/refresh', (route: Route) =>
    route.fulfill({ json: health.cli }),
  );
  await page.route('**/api/orgs**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 2) {
      if (options.calls) options.calls.orgs += 1;
      return route.fulfill({ json: state.mode === 'demo' ? demoOrgs : state.orgs });
    }
    const alias = decodeURIComponent(segments[2] ?? '');
    if (segments[3] === 'data-transforms' && segments[4]) {
      const id = decodeURIComponent(segments[4]);
      const bundle = demoTransformBundles[id];
      if (options.transformDetailDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.transformDetailDelayMs));
      }
      return bundle
        ? route.fulfill({ json: bundle })
        : route.fulfill({ status: 404, json: { error: { code: 'TRANSFORM_NOT_FOUND', message: 'Unknown transform' } } });
    }
    if (segments[3] === 'inventory') {
      if (options.calls) options.calls.inventory += 1;
      const inventory = state.mode === 'demo' ? demoInventory : state.inventories[alias] ?? demoInventory;
      if (segments[4] === 'session') {
        options.sessionStartBodies?.push(route.request().postDataJSON() as Record<string, unknown>);
        const sessionId = segments[5] ?? 'e2e-session';
        return route.fulfill({ json: { sessionId, snapshot: inventory } });
      }
      return route.fulfill({ json: inventory });
    }
    const org = [...demoOrgs, ...state.orgs].find((entry) => entry.alias === alias);
    return org
      ? route.fulfill({ json: org })
      : route.fulfill({ status: 404, json: { error: { code: 'ORG_NOT_FOUND', message: 'Unknown org' } } });
  });
}

async function seedLiveMode(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('dcat.mode', 'live');
    } catch {
      // Storage may be unavailable; the mocked session still supplies live mode.
    }
  });
}

async function openDemo(page: Page) {
  await mockConnector(page, createConnectorState());
  await page.goto('/');
}

const PERSISTED_CACHE_KEY = 'dcat.inventory-cache.v1';

async function readPersistedCache(page: Page): Promise<string | null> {
  return page.evaluate((key) => new Promise<string | null>((resolve, reject) => {
    const open = indexedDB.open('keyval-store', 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('keyval')) db.createObjectStore('keyval');
    };
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed.'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('keyval', 'readonly');
      const request = tx.objectStore('keyval').get(key);
      request.onsuccess = () => {
        const value: unknown = request.result;
        db.close();
        resolve(typeof value === 'string' ? value : value == null ? null : JSON.stringify(value));
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error('IndexedDB read failed.'));
      };
    };
  }), PERSISTED_CACHE_KEY);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('dcat.mode', 'demo');
      // Seed once only: a reload must keep a theme the user chose during the test.
      if (!localStorage.getItem('dcat.theme')) localStorage.setItem('dcat.theme', 'light');
    } catch {
      // Storage may be unavailable in a locked-down browser; defaults still apply.
    }
  });
});

test('demo first impression shows the inventory and the CTA opens an explorer', async ({ page }) => {
  await openDemo(page);

  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', '/dcat-mark.svg');
  await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('#desktop-sidebar img[src="/dcat-icon-192.png"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore the inventory' })).toBeVisible();
  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toHaveAttribute(
    'title',
    'Sample metadata only - no Salesforce org is connected.',
  );
  await expect(page.getByText('Sample metadata only - no Salesforce org is connected.')).toHaveCount(0);
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.locator('header').getByText(/SF CLI (ready|missing|checking)/)).toHaveCount(0);
  await expect(page.getByText('Your Data 360 model, clearly mapped.')).toBeVisible();
  await expect(page.locator('.hero-title-accent')).toHaveText('clearly mapped.');
  await expect(page.getByText('Data Lake Objects')).toBeVisible();
  await expect(page.getByText('Complete · 100%')).toBeVisible();
  await expect(page.getByText('Inventory loaded with gaps')).toHaveCount(0);

  await page.getByRole('button', { name: 'Explore the inventory' }).click();
  await expect(page.locator('h1')).toHaveText('DLO Explorer');
  await expect(page.locator('input[placeholder="Search DLOs or fields"]')).toBeVisible();
});

test('org switcher and details page use the authenticated demo org', async ({ page }) => {
  await openDemo(page);

  const picker = page.getByLabel('Selected organization');
  await expect(picker).toHaveValue('demo-uat');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await expect(page.locator('h1')).toHaveText('Org Connections');
  await expect(
    page.getByRole('table', { name: 'Authenticated Salesforce orgs' }).getByText('demo-uat', { exact: true }),
  ).toBeVisible();
});

test('menu links use real paths and browser history restores the right view', async ({ page }) => {
  await openDemo(page);
  const sidebar = page.locator('#desktop-sidebar');

  await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
  const dloLink = sidebar.getByRole('link', { name: 'DLO Explorer' });
  await expect(dloLink).toHaveAttribute('href', '/dlos');

  await dloLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dlos');
  await expect(page.locator('h1')).toHaveText('DLO Explorer');

  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('h1')).toHaveText('Dashboard');

  await page.goForward();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/dlos');
  await expect(page.locator('h1')).toHaveText('DLO Explorer');

  await page.goto('/does-not-exist');
  await expect(page.locator('h1')).toHaveText('Dashboard');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');

  // Legacy `#page` bookmarks are accepted once and normalized to a real path.
  await page.goto('/#data-streams');
  await expect(page.locator('h1')).toHaveText('Data Stream Explorer');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/data-streams');
});

test('routes expose crawlable URLs and per-page metadata', async ({ page }) => {
  await openDemo(page);

  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page).toHaveTitle('DCAT | Data Cloud Architect Toolkit');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://sfdcat.pages.dev/');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /local-first, read-only workbench/,
  );

  await page.goto('/about');
  await expect(page).toHaveTitle('About DCAT | Data Cloud Architect Toolkit');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://sfdcat.pages.dev/about');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'About DCAT | Data Cloud Architect Toolkit',
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://sfdcat.pages.dev/about');
});

test('reload restores cached inventory and navigation does not retrieve it again', async ({ page }) => {
  const calls = { orgs: 0, inventory: 0 };
  await mockConnector(page, createConnectorState(), { calls });
  await page.goto('/');

  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect.poll(() => calls.orgs).toBe(1);
  await expect.poll(() => calls.inventory).toBeGreaterThan(0);
  // The async persister writes after cache events; wait for both allowlisted
  // snapshots before reloading so the test verifies restore, not write timing.
  await expect.poll(async () => (await readPersistedCache(page)) ?? '').toContain('"orgs"');
  await expect.poll(async () => (await readPersistedCache(page)) ?? '').toContain('"inventory"');
  const inventoryCallsAfterLoad = calls.inventory;
  await expect(page.getByTestId('inventory-freshness')).toContainText('Updated');

  await page.reload();

  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.getByTestId('inventory-freshness')).toContainText('Updated');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  await expect(page.getByRole('table', { name: 'DLO Explorer results' })).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Stream Explorer' }).click();
  await expect(page.getByRole('table', { name: 'Data Stream Explorer results' })).toBeVisible();

  expect(calls.orgs).toBe(1);
  expect(calls.inventory).toBe(inventoryCallsAfterLoad);

  const beforeManualRefresh = calls.inventory;
  await page.getByRole('main').getByRole('button', { name: 'Refresh inventory' }).click();
  await expect.poll(() => calls.inventory).toBeGreaterThan(beforeManualRefresh);
});

test('live reload restores the live context without demo crossover', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  const calls = { orgs: 0, inventory: 0 };
  await seedLiveMode(page);
  await mockConnector(page, state, { calls });
  await page.goto('/');

  await expect(page.getByText('Live org metadata')).toBeVisible();
  await expect.poll(() => calls.orgs).toBe(1);
  await expect.poll(() => calls.inventory).toBeGreaterThan(0);
  await expect.poll(async () => (await readPersistedCache(page)) ?? '').toContain('"orgs","live"');
  await expect.poll(async () => (await readPersistedCache(page)) ?? '').toContain('"inventory","live:');
  const inventoryCallsAfterLoad = calls.inventory;

  await page.reload();

  await expect(page.getByText('Live org metadata')).toBeVisible();
  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toHaveCount(0);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Spaces' }).click();
  await expect(page.locator('#main-content').getByRole('heading', { name: 'Data Spaces' })).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DMO Explorer' }).click();
  await expect(page.getByRole('table', { name: 'DMO Explorer results' })).toBeVisible();

  expect(calls.orgs).toBe(1);
  expect(calls.inventory).toBe(inventoryCallsAfterLoad);
});

test('a first-load relay timeout clears immediately and resumes a fresh full inventory', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  const sessionBodies: Array<Record<string, unknown>> = [];
  let sessionAttempts = 0;
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.route('**/api/orgs/*/inventory/session', async (route: Route) => {
    sessionAttempts += 1;
    sessionBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (sessionAttempts === 1) {
      return route.fulfill({
        status: 504,
        json: { error: { code: 'RELAY_TIMEOUT', message: 'The bridge did not answer in time.' } },
      });
    }
    // Hold the fresh session open long enough to prove the error is gone while
    // the retry is still loading, not merely after rows arrive.
    await new Promise((resolve) => setTimeout(resolve, 900));
    return route.fallback();
  });
  await page.goto('/');

  const alert = page.getByRole('alert').filter({ hasText: "The bridge didn't respond in time." });
  await expect(alert).toBeVisible();
  await expect(page.getByText('Live org metadata')).toHaveCount(0);

  await alert.getByRole('button', { name: 'Resume loading' }).click();

  await expect.poll(() => sessionAttempts).toBe(2);
  await expect(alert).toHaveCount(0);
  await expect(page.getByText('Discovering your Data 360 inventory')).toBeVisible();
  expect(sessionBodies[1]).toMatchObject({ refresh: true });
  expect(sessionBodies[1]?.sessionId).toBeUndefined();

  await expect(page.getByText('Live org metadata')).toBeVisible();
});

test('live Data Spaces counts use nested live attribution without false discovery errors', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  const org = state.orgs[0]!;
  const source = demoInventory;
  state.inventories[org.alias] = {
    ...structuredClone(source),
    org,
    mode: 'live',
    dataSpaces: [{ ...source.dataSpaces[0]!, apiName: 'default', label: 'default', isDefault: true }],
    dlos: [
      { ...source.dlos[0]!, apiName: 'Account_Home__dll', dataSpace: 'default' },
      { ...source.dlos[1]!, apiName: 'Order_Home__dll', dataSpace: 'sales_space' },
    ],
    dmos: [
      { ...source.dmos[0]!, apiName: 'ssot__Account__dlm', dataSpace: 'default' },
      { ...source.dmos[1]!, apiName: 'ssot__Order__dlm', dataSpace: 'default' },
    ],
    dataStreams: [
      { ...source.dataStreams[0]!, apiName: 'Account_Home', targetDlo: 'Account_Home__dll' },
      { ...source.dataStreams[0]!, apiName: 'Order_Home', targetDlo: 'Order_Home__dll' },
    ],
    warnings: [],
  };

  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await expect(page.getByText('Live org metadata')).toBeVisible();
  for (const message of [
    'The dmos response did not contain a recognizable collection.',
    'DMO or Source Object (CRM) developer Name is missing',
  ]) {
    await expect(page.getByText(message)).toHaveCount(0);
  }

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Spaces' }).click();
  const card = page.locator('#main-content section.panel').filter({
    has: page.getByRole('heading', { name: 'default' }),
  }).first();
  await expect(card.getByText('DLOs').locator('..')).toContainText('1');
  await expect(card.getByText('DMOs').locator('..')).toContainText('2');
  await expect(card.getByText('Streams').locator('..')).toContainText('1');
});

test('persisted cache never contains a session token', async ({ page }) => {
  await mockConnector(page, createConnectorState());
  await page.goto('/');

  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect.poll(() => readPersistedCache(page)).not.toBeNull();

  const cache = await readPersistedCache(page);
  const localStorageText = await page.evaluate(() =>
    Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'));

  expect(cache).not.toContain('e2e-token');
  expect(localStorageText).not.toContain('e2e-token');
});

test('switching to live mode announces the context and never flashes demo metadata', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toBeVisible();

  // The demo label is still legitimate while the switch is pending. Flag only
  // a reappearance after it has gone away: that would be a stale-cache flash.
  await page.evaluate(() => {
    let demoRemoved = false;
    window.__demoAfterSwitch = false;
    const observer = new MutationObserver(() => {
      const hasDemoLabel = document.body.innerText.includes('Sample inventory');
      if (!hasDemoLabel) demoRemoved = true;
      else if (demoRemoved) window.__demoAfterSwitch = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__switchObserver = observer;
  });

  await page.getByRole('button', { name: 'Switch to live mode' }).click();

  const notice = 'Now using live mode - reading metadata from your Salesforce CLI.';
  await expect(page.locator('.sr-only[aria-live="polite"]')).toHaveText(notice);
  await expect(page.locator('.mode-toast')).toContainText(notice);
  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await expect(page.getByText('Live org metadata')).toBeVisible();

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  const liveRows = page.getByRole('table', { name: 'DLO Explorer results' });
  await expect(liveRows.getByText('Production Account')).toBeVisible();
  await expect(liveRows.getByText('Account DLO', { exact: true })).toHaveCount(0);
  await expect(liveRows.getByText('Live Account DLO')).toHaveCount(0);
  expect(await page.evaluate(() => window.__demoAfterSwitch)).toBe(false);
  await page.evaluate(() => window.__switchObserver?.disconnect());
});

test('switching demo to live keeps the header height stable and freshness in a compact chip', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByText('Sample inventory')).toBeVisible();

  const header = page.locator('header');
  const titleBlock = header.locator('h1').locator('..');
  const titleHeight = () => titleBlock.evaluate((element) => element.getBoundingClientRect().height);
  const demoTitleHeight = await titleHeight();
  await expect(header.getByText(/^Updated /)).toHaveCount(0);
  const freshness = page.locator('#main-content').getByTestId('inventory-freshness');
  await expect(freshness).toBeVisible();
  await expect(freshness).toHaveText(/^Updated /);
  await expect(freshness.locator('[title^="Updated "]')).toHaveAttribute('title', /Updated .*\d{4}/);
  const chip = await freshness.boundingBox();
  expect(chip, 'freshness chip bounds').not.toBeNull();
  expect(chip!.height).toBeLessThanOrEqual(40);
  expect(chip!.width).toBeLessThan(280);
  await expect(freshness.getByRole('button', { name: 'Refresh inventory' })).toHaveAttribute(
    'title',
    'Refresh this inventory from the local connector',
  );

  await page.getByRole('button', { name: 'Switch to live mode' }).click();
  await expect(header.getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await expect(page.getByText('Live org metadata')).toBeVisible();

  expect(await titleHeight()).toBe(demoTitleHeight);
  await expect(header.getByText(/^Updated /)).toHaveCount(0);
  await expect(page.locator('#main-content').getByTestId('inventory-freshness')).toBeVisible();
});

test('settings refreshes compatibility in place without duplicating the workspace mode', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();

  const modeFact = page.locator('dt').filter({ hasText: /^Mode$/ });
  await expect(modeFact).toHaveCount(0);
  const apiVersionFact = page.locator('dt').filter({ hasText: 'Salesforce API version' }).locator('..');
  await expect(apiVersionFact).toContainText('v65.0');

  await page.getByRole('button', { name: 'Switch to live mode' }).click();
  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await expect(modeFact).toHaveCount(0);
  await expect(apiVersionFact).toContainText('v67.0');
});

test('compatibility settings save a curated version and reuse the inventory refresh', async ({ page }) => {
  const calls = { orgs: 0, inventory: 0 };
  await mockConnector(page, createConnectorState(), { calls });
  await page.goto('/');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();

  const apiVersionFact = page.locator('dt').filter({ hasText: 'Salesforce API version' }).locator('..');
  await expect(apiVersionFact).toContainText('v65.0');
  await page.getByRole('button', { name: 'Switch to live mode' }).click();
  await expect(apiVersionFact).toContainText('v67.0');

  const disclosure = page.locator('.disclosure-content');
  expect((await disclosure.boundingBox())?.height).toBe(0);

  await page.getByText('Change API version').click();
  await expect(disclosure).toHaveAttribute('data-open', 'true');
  const motion = await disclosure.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  expect(motion.property).toContain('grid-template-rows');
  expect(motion.duration).toBe('0.2s');

  await page.locator('input[name="api-version-choice"]').nth(2).check();
  await page.getByLabel('Specific API version').selectOption('68.0');
  const inventoryBefore = calls.inventory;
  await page.getByRole('button', { name: 'Save & refresh' }).click();

  await expect(page.getByText('API version saved. DCAT is refreshing metadata.')).toBeVisible();
  await expect.poll(() => calls.inventory).toBeGreaterThan(inventoryBefore);
  await expect(apiVersionFact).toContainText('v68.0');
});

test('settings places the combined bridge panel beside appearance on desktop', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();

  const bridgePanel = page.locator('.panel').filter({
    has: page.getByRole('heading', { name: 'Bridge and API compatibility' }),
  });
  const appearancePanel = page.locator('.panel').filter({
    has: page.getByRole('heading', { name: 'Appearance' }),
  });

  await expect(bridgePanel).toBeVisible();
  await expect(appearancePanel).toBeVisible();
  const boxes = await page.evaluate(() => {
    const rect = (title: string) => {
      const panel = Array.from(document.querySelectorAll<HTMLElement>('.panel')).find((candidate) =>
        Array.from(candidate.querySelectorAll('h2')).some((heading) => heading.textContent?.trim() === title),
      );
      if (!panel) return null;
      const { x, y, width, height } = panel.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      bridge: rect('Bridge and API compatibility'),
      appearance: rect('Appearance'),
    };
  });

  expect(boxes.bridge, 'bridge panel bounds').not.toBeNull();
  expect(boxes.appearance, 'appearance panel bounds').not.toBeNull();
  expect(boxes.bridge!.x).toBeLessThan(boxes.appearance!.x);
  expect(Math.abs(boxes.bridge!.y - boxes.appearance!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.bridge!.height - boxes.appearance!.height)).toBeLessThanOrEqual(1);
  const gap = boxes.appearance!.x - (boxes.bridge!.x + boxes.bridge!.width);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(32);
});

test('switching live to demo clears live org setup state and disables live controls', async ({ page }) => {
  await seedLiveMode(page);
  await mockConnector(page, createConnectorState());
  await page.goto('/orgs');

  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  const alias = page.getByLabel('Org alias');
  await alias.fill('live-org-alias');
  await expect(page.getByRole('button', { name: 'Connect org' })).toBeEnabled();

  await page.getByRole('button', { name: 'Switch to demo mode' }).click();

  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toBeVisible();
  await expect(page.getByText(/Demo mode runs on labelled sample data/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect org' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Re-check CLI' })).toBeDisabled();
  await expect(alias).toHaveValue('my-data360-org');
  await expect(page.getByText('live-org-alias')).toHaveCount(0);
  await expect(page.getByText(/Finish setup to view live inventory/)).toHaveCount(0);
});

test('stored data controls clear caches, reset layouts, and gate a full erase', async ({ page }) => {
  const calls = { orgs: 0, inventory: 0 };
  await page.addInitScript(() => {
    try {
      localStorage.setItem('dcat.theme', 'dark');
      localStorage.setItem('dcat.sidebarCollapsed', 'true');
      localStorage.setItem('dcat.erd.v1.demo:demo-uat', '{"nodes":[]}');
      localStorage.setItem('dcat.lineage.v1.demo:demo-uat', '{"nodes":[]}');
      localStorage.setItem('unrelated-app', 'keep');
    } catch {
      // Storage may be unavailable in a locked-down browser.
    }
  });
  await mockConnector(page, createConnectorState(), { calls });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#desktop-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();

  const storedData = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: 'Stored data' }),
  });
  await expect(storedData).toContainText('DCAT caches org lists and loaded inventory snapshots here for up to 7 days');
  await expect(storedData).toContainText('Access tokens, pairing codes, and customer records are never persisted.');

  const orgsBeforeClear = calls.orgs;
  await storedData.getByRole('button', { name: 'Clear cached metadata' }).click();
  await expect(storedData.getByRole('status')).toContainText('Cached metadata cleared');
  await expect.poll(() => calls.orgs).toBeGreaterThan(orgsBeforeClear);

  await storedData.getByRole('button', { name: 'Reset saved layouts' }).click();
  await expect(storedData.getByRole('status')).toContainText('Saved ERD and Lineage layouts reset');
  expect(await page.evaluate(() => [
    localStorage.getItem('dcat.erd.v1.demo:demo-uat'),
    localStorage.getItem('dcat.lineage.v1.demo:demo-uat'),
  ])).toEqual([null, null]);

  await storedData.getByRole('button', { name: 'Erase all local data' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Erase all local data?' })).toBeVisible();
  await expect(dialog).toContainText('Cached org lists and inventory snapshots');
  await expect(dialog).toContainText('Bridge pairing or the local bridge installation');
  await dialog.getByRole('button', { name: 'Keep my data' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('dcat.theme'))).toBe('dark');
  expect(await page.evaluate(() => Boolean(localStorage.getItem('dcat.mode')))).toBe(true);
  expect(await page.evaluate(() => Boolean(localStorage.getItem('dcat.selectedOrg')))).toBe(true);

  await storedData.getByRole('button', { name: 'Erase all local data' }).click();
  await dialog.getByRole('button', { name: 'Erase all local data' }).click();
  await expect(storedData.getByRole('status')).toContainText('All local data erased');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => [
    localStorage.getItem('dcat.theme'),
    localStorage.getItem('dcat.hiddenOrgs'),
    localStorage.getItem('dcat.sidebarCollapsed'),
    localStorage.getItem('dcat.erd.v1.demo:demo-uat'),
    localStorage.getItem('dcat.lineage.v1.demo:demo-uat'),
    localStorage.getItem('dcat.mode'),
    localStorage.getItem('dcat.selectedOrg'),
  ])).toEqual([null, null, null, null, null, null, null]);
  expect(await page.evaluate(() => localStorage.getItem('unrelated-app'))).toBe('keep');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#desktop-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toBeVisible();
});

test('erasing from live mode keeps the demo reset and does not restore live mode', async ({ page }) => {
  const modeCalls: string[] = [];
  await seedLiveMode(page);
  await mockConnector(page, createConnectorState(), { modeCalls });
  await page.goto('/');

  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();
  await page.getByRole('button', { name: 'Erase all local data' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Erase all local data' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('All local data erased');
  await expect(page.locator('header').getByText('DEMO DATA', { exact: true })).toBeVisible();
  await expect.poll(() => modeCalls).toEqual(['live', 'demo']);
  expect(await page.evaluate(() => [
    localStorage.getItem('dcat.mode'),
    localStorage.getItem('dcat.selectedOrg'),
  ])).toEqual([null, null]);
});

test('demo mode without an org never presents itself as live', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('dcat.selectedOrg', 'missing-demo-org');
    } catch {
      // Storage may be unavailable in a locked-down browser.
    }
  });
  await mockConnector(page, createConnectorState());
  // Force the empty path: an org-less demo session is still a demo session.
  await page.route('**/api/orgs**', (route) => route.fulfill({ json: [] }));
  await page.goto('/');

  await expect(page.locator('header').getByText('DEMO · NO ORG SELECTED', { exact: true })).toBeVisible();
  await expect(page.locator('header').getByText('LIVE · NOT CONNECTED', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use demo mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch to live mode' })).toBeVisible();
});

test('live Discovery Health and Needs attention stay inside the viewport', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  const longToken = 'GovernanceConfigurationIdentifierThatCannotWrapAtAnyReasonableViewportWidthAndMustNotPushThePanelOffScreen';
  const inventory = state.inventories['prod-org']!;
  state.inventories['prod-org'] = {
    ...inventory,
    capabilities: inventory.capabilities.map((capability, index) => index === 0
      ? { ...capability, status: 'partial' as const, itemCount: 42, message: longToken }
      : capability),
    warnings: [
      ...inventory.warnings,
      {
        family: 'data-streams',
        code: 'PARTIAL_RESULT',
        message: `${longToken} ${longToken}`,
        severity: 'warning' as const,
      },
    ],
  };
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await expect(page.getByText('Live org metadata')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  const warningMessage = page.getByText(`${longToken} ${longToken}`);
  await expect(warningMessage).toBeVisible();

  for (const width of [1440, 834, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('section.panel')].find((section) =>
        section.querySelector('h2')?.textContent?.trim() === 'Needs attention',
      );
      const rect = panel?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panelLeft: rect?.left ?? 0,
        panelRight: rect?.right ?? 0,
      };
    });

    expect(metrics.documentWidth, `document at ${width}px`).toBeLessThanOrEqual(metrics.innerWidth + 1);
    expect(metrics.panelRight, `panel right at ${width}px`).toBeLessThanOrEqual(metrics.innerWidth + 1);
    expect(metrics.panelLeft, `panel left at ${width}px`).toBeGreaterThanOrEqual(-1);

    const warningBox = await warningMessage.boundingBox();
    expect(warningBox, `warning at ${width}px`).not.toBeNull();
    expect(warningBox!.x, `warning left at ${width}px`).toBeGreaterThanOrEqual(-1);
    expect(warningBox!.x + warningBox!.width, `warning right at ${width}px`).toBeLessThanOrEqual(width + 1);
  }
});

test('live mode without an org leads with Select an org and offers the demo fallback', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  state.orgs = [];
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await expect(page.locator('header').getByText('LIVE · NOT CONNECTED', { exact: true })).toBeVisible();
  await expect(page.locator('#main-content').getByText('No org selected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select an org' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use demo mode' })).toBeVisible();

  await page.getByRole('button', { name: 'Use demo mode' }).click();
  await expect(page.locator('.sr-only[aria-live="polite"]')).toHaveText(
    'Now using demo mode - sample metadata only.',
  );
  await expect(page.getByText('Sample inventory')).toBeVisible();
});

test('switching demo to live clears demo orgs from the live inventory list', async ({ page }) => {
  const state = createConnectorState();
  state.orgs = [];
  await mockConnector(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await expect(
    page.getByRole('table', { name: 'Authenticated Salesforce orgs' }).getByText('demo-uat', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Switch to live mode' }).click();

  await expect(page.getByText('No authenticated orgs yet')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Authenticated Salesforce orgs' })).toHaveCount(0);
  await expect(page.getByText('demo-uat', { exact: true })).toHaveCount(0);
});

test('switching to live shows an org-check skeleton while the org list is pending', async ({ page }) => {
  const state = createConnectorState();
  await mockConnector(page, state);
  await page.goto('/');
  await expect(page.getByText('Sample inventory')).toBeVisible();

  let releaseOrgs!: () => void;
  const orgsHeld = new Promise<void>((resolve) => {
    releaseOrgs = resolve;
  });
  await page.route('**/api/orgs', async (route: Route) => {
    await orgsHeld;
    await route.fulfill({ json: [] });
  });

  await page.getByRole('button', { name: 'Switch to live mode' }).click();

  const status = page.getByRole('status').filter({ hasText: 'Checking for Salesforce orgs...' });
  await expect(status).toBeVisible();
  await expect(page.locator('#main-content').getByText('No org selected')).toHaveCount(0);
  await expect(page.locator('#main-content').getByRole('button', { name: 'Select an org' })).toHaveCount(0);
  await expect(page.locator('#main-content').getByRole('button', { name: 'Use demo mode' })).toHaveCount(0);
  await expect(page.getByLabel('Selected organization')).toContainText('Checking for orgs...');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  await expect(status).toBeVisible();
  await expect(page.getByText('No authenticated orgs yet')).toHaveCount(0);

  releaseOrgs();
  await expect(page.getByText('No authenticated orgs yet')).toBeVisible();
  await expect(status).toHaveCount(0);
});

test('live orgs can be hidden from DCAT and restored without logging out', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Org Connections' }).click();
  const table = page.getByRole('table', { name: 'Authenticated Salesforce orgs' });
  await expect(table.getByText('prod-org', { exact: true })).toBeVisible();

  await table.getByRole('button', { name: 'Remove prod-org' }).click();
  await table.getByRole('button', { name: 'Confirm remove prod-org' }).click();

  await expect(table.getByText('prod-org', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/hidden from DCAT only/)).toBeVisible();

  await page.getByRole('button', { name: 'Show removed orgs (1)' }).click();
  const hiddenTable = page.getByRole('table', { name: 'Orgs hidden from DCAT' });
  await expect(hiddenTable.getByText('prod-org', { exact: true })).toBeVisible();
  await hiddenTable.getByRole('button', { name: 'Restore prod-org' }).click();

  await expect(table.getByText('prod-org', { exact: true })).toBeVisible();
});

test('switching live orgs replaces cached metadata instead of showing the previous org', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await expect(page.getByLabel('Selected organization')).toHaveValue('prod-org');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  const rows = page.getByRole('table', { name: 'DLO Explorer results' });
  await expect(rows.getByText('Production Account')).toBeVisible();
  await expect(rows.getByText('Sandbox Account')).toHaveCount(0);

  await page.getByLabel('Selected organization').selectOption('sandbox-org');

  // Selecting an org returns to the Dashboard to establish the new context.
  await expect(page.locator('h1')).toHaveText('Dashboard');
  await expect(page.locator('header').getByText('LIVE · SANDBOX', { exact: true })).toBeVisible();
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  await expect(rows.getByText('Sandbox Account')).toBeVisible();
  await expect(rows.getByText('Production Account')).toHaveCount(0);
});

test('object details use tabs, breadcrumbs, and metadata copy actions', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();

  const rows = page.getByRole('table', { name: 'DLO Explorer results' });
  await expect(rows.getByText('Has mapping').first()).toBeVisible();
  await expect(rows.getByText('No mapping found').first()).toBeVisible();

  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('DLO Explorer / Account DLO')).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Overview' })).toBeVisible();

  await dialog.getByRole('tab', { name: 'Fields (8)' }).click();
  await expect(dialog.getByRole('table', { name: 'Object fields' })).toBeVisible();

  await dialog.getByRole('tab', { name: 'Raw Metadata' }).click();
  await expect(dialog.getByText(/"apiName": "Account_DLO__dll"/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Copy API name' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Account_DLO__dll');
});

test('inventory refresh is contextual and detail drawers stay unobstructed', async ({ page }) => {
  await openDemo(page);

  // Refresh is a content action, not a second header control beside mode switching.
  await expect(page.locator('header').getByRole('button', { name: 'Refresh inventory' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Refresh inventory' })).toBeVisible();

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'Refresh inventory' })).toBeVisible();

  await page.getByRole('table', { name: 'DLO Explorer results' }).getByRole('button', { name: 'Details', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The slide-in transform reports subpixel widths while it is still running.
  await dialog.evaluate((element) =>
    Promise.allSettled(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );

  const width = Math.round((await page.getByTestId('drawer-panel').boundingBox())?.width ?? 0);
  expect(width).toBeGreaterThan(640);
  expect(width).toBeLessThanOrEqual(768);

  const geometry = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('[data-testid="drawer-overlay"]')!;
    const panel = document.querySelector<HTMLElement>('[data-testid="drawer-panel"]')!;
    const content = panel.querySelector<HTMLElement>(':scope > div.flex-1')!;
    return {
      overlayTop: overlay.getBoundingClientRect().top,
      overlayBottom: overlay.getBoundingClientRect().bottom,
      panelTop: panel.getBoundingClientRect().top,
      panelBottom: panel.getBoundingClientRect().bottom,
      contentBottom: content.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
      contentMinHeight: getComputedStyle(content).minHeight,
    };
  });
  expect(geometry.overlayTop).toBe(0);
  expect(geometry.overlayBottom).toBe(geometry.viewportHeight);
  expect(geometry.panelTop).toBe(0);
  expect(geometry.panelBottom).toBe(geometry.viewportHeight);
  expect(geometry.contentBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.contentMinHeight).toBe('0px');

  const catcherStyle = await page.getByTestId('drawer-click-catcher').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, backdrop: style.backdropFilter };
  });
  expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(catcherStyle.background);
  expect(catcherStyle.backdrop).toBe('none');
});

test('detail drawer can switch to full width and remembers the choice', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  const rows = page.getByRole('table', { name: 'DLO Explorer results' });
  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();

  const panel = page.getByTestId('drawer-panel');
  const toggle = panel.getByRole('button', { name: 'Full width' });
  const panelWidth = async () => Math.round((await panel.boundingBox())?.width ?? 0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await panelWidth()).toBeLessThanOrEqual(768);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(panelWidth).toBe(page.viewportSize()!.width);

  await page.getByRole('button', { name: 'Close details' }).last().click();
  await rows.getByRole('button', { name: 'Details', exact: true }).nth(1).click();
  await expect(panel.getByRole('button', { name: 'Full width' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(panelWidth).toBe(page.viewportSize()!.width);

  await panel.getByRole('button', { name: 'Full width' }).click();
  await expect.poll(panelWidth).toBeLessThanOrEqual(768);
});

test('page-level refresh sends its family scope while Dashboard sends all families', async ({ page }) => {
  const sessionStarts: Array<Record<string, unknown>> = [];
  await mockConnector(page, createConnectorState(), { sessionStartBodies: sessionStarts });
  await page.goto('/');

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  await page.getByRole('main').getByRole('button', { name: 'Refresh inventory' }).click();
  await expect.poll(() => sessionStarts.filter((body) => body.refresh === true).length).toBeGreaterThan(0);
  const dloRefresh = sessionStarts.filter((body) => body.refresh === true).at(-1);
  expect(dloRefresh?.families).toEqual(['dlos', 'mappings', 'data-streams']);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('main').getByRole('button', { name: 'Refresh inventory' }).click();
  await expect.poll(() => sessionStarts.filter((body) => body.refresh === true).length).toBeGreaterThan(1);
  const dashboardRefresh = sessionStarts.filter((body) => body.refresh === true).at(-1);
  expect(dashboardRefresh?.families).toEqual(RESOURCE_FAMILIES);
});

test('a slow refresh can be cancelled instead of leaving a permanent spinner', async ({ page }) => {
  await openDemo(page);
  let routeFinished = false;
  await page.route('**/api/orgs/*/inventory/session', async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ json: { sessionId: 'e2e-session', snapshot: demoInventory } });
    routeFinished = true;
  });

  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  const spinner = page.getByRole('img', { name: 'Inventory loading' });
  await expect(spinner).toBeVisible();
  // The last usable snapshot stays on screen while the refresh streams in.
  await expect(page.getByText('Sample inventory')).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Cancel refresh' });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect(spinner).toHaveCount(0);
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh inventory' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => routeFinished).toBe(true);
});

test('detail drawer content scrolls inside a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Transform Explorer' }).click();
  await page.getByRole('table', { name: 'Data Transform Explorer results' })
    .getByRole('button', { name: 'Details', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const scroll = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="drawer-panel"]')!;
    const content = panel.querySelector<HTMLElement>(':scope > div.flex-1')!;
    content.scrollTop = content.scrollHeight;
    const last = content.lastElementChild!.getBoundingClientRect();
    return {
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollTop: content.scrollTop,
      lastBottom: last.bottom,
      panelBottom: panel.getBoundingClientRect().bottom,
    };
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollTop).toBeGreaterThan(0);
  expect(scroll.lastBottom).toBeLessThanOrEqual(scroll.panelBottom + 1);
});

test('live export surfaces the metadata sharing notice', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  const notice = "This export contains metadata about your Salesforce org. Store and share it according to your organization's security policies.";
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Dictionary' }).click();
  await expect(page.getByText(notice)).toBeVisible();

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'ERD Explorer' }).click();
  await expect(page.getByText(notice)).toBeVisible();

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Lineage Explorer' }).click();
  await expect(page.locator('h1')).toHaveText('Data Lineage Explorer');
  await expect(page.getByText('30 steps', { exact: true })).toBeVisible();
  await expect(page.getByText(notice)).toBeVisible();
});

test('data stream explorer shows grounded source-to-target detail and visible exports', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Stream Explorer' }).click();
  await expect(page.locator('h1')).toHaveText('Data Stream Explorer');

  const rows = page.getByRole('table', { name: 'Data Stream Explorer results' });
  await expect(rows.getByText('Accounts Stream', { exact: true })).toBeVisible();
  await expect(rows.getByText('Web Events Stream', { exact: true })).toBeVisible();
  await expect(rows.getByText('Paused', { exact: true })).toBeVisible();

  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('Paused');
  await expect(page.getByText('1 of 6 streams')).toBeVisible();
  await expect(rows.getByText('Web Events Stream', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('all');

  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Accounts Stream' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Data Stream Explorer / Accounts Stream')).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Target DLO' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Raw Metadata' })).toBeVisible();
  await expect(drawer.getByText('Salesforce CRM', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Demo Salesforce Org', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Connected · SalesforceDotCom_Home', { exact: true })).toBeVisible();

  await drawer.getByRole('tab', { name: 'Target DLO' }).click();
  await expect(drawer.getByText('Known in inventory')).toBeVisible();
  await expect(drawer.getByText(/No stream lineage is inferred/)).toBeVisible();
  await expect(drawer.getByText(/does not invent the target object/)).toHaveCount(0);

  await drawer.getByRole('tab', { name: 'Raw Metadata' }).click();
  await expect(drawer.getByText(/"apiName": "Accounts_Stream"/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Close details' }).last().click();

  await page.getByRole('button', { name: 'Export' }).click();
  const menu = page.getByRole('menu', { name: 'Export' });
  await expect(menu.getByRole('menuitem', { name: /CSV/ })).toContainText('Visible streams');
  await expect(menu.getByRole('menuitem', { name: /JSON/ })).toContainText('Complete machine-readable inventory');
  await page.keyboard.press('Escape');
});

test('data transform explorer shows grounded detail, lineage, and run states', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Transform Explorer' }).click();
  await expect(page.locator('h1')).toHaveText('Data Transform Explorer');

  const rows = page.getByRole('table', { name: 'Data Transform Explorer results' });
  await expect(rows.getByText('Normalize Contacts', { exact: true })).toBeVisible();
  await expect(rows.getByText('Stream Click Events', { exact: true })).toBeVisible();
  await expect(rows.getByText('Legacy Account Sync', { exact: true })).toBeVisible();
  await expect(rows.getByText('Enrich Order Items', { exact: true })).toBeVisible();
  await expect(rows.getByText('Route Support Cases', { exact: true })).toBeVisible();

  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Normalize Contacts' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Data Transform Explorer / Normalize Contacts')).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Flow & Lineage' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Visual Definition' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Definition', exact: true })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Run History (2)' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Raw Metadata' })).toBeVisible();

  // Transform status and last-run status must remain distinct fields.
  await expect(drawer.getByText('Active', { exact: true }).first()).toBeVisible();
  await expect(drawer.getByText('Success', { exact: true }).first()).toBeVisible();

  await drawer.getByRole('tab', { name: 'Flow & Lineage' }).click();
  await expect(drawer.getByText('Account_DLO__dll')).toBeVisible();
  await expect(drawer.getByText('Known in inventory').first()).toBeVisible();

  await drawer.getByRole('tab', { name: 'Visual Definition' }).click();
  await expect(drawer.getByRole('region', { name: 'Data transform definition canvas' })).toBeVisible();
  await expect(drawer.locator('.react-flow__node-transformStep')).toHaveCount(3);
  await expect(drawer.locator('.react-flow__edge')).toHaveCount(2);
  await expect(drawer.getByText('Read-only Salesforce canvas')).toBeVisible();

  await drawer.getByRole('tab', { name: 'Run History (2)' }).click();
  await expect(drawer.getByRole('table', { name: 'Transform run history' })).toBeVisible();
  await expect(drawer.getByText('run-2026-11-17-001')).toBeVisible();

  await drawer.getByRole('button', { name: 'Close details' }).last().click();
  await rows.getByRole('button', { name: 'Details', exact: true }).nth(1).click();
  const streaming = page.getByRole('dialog', { name: 'Stream Click Events' });
  await expect(streaming.getByText('Streaming', { exact: true }).first()).toBeVisible();
  await streaming.getByRole('tab', { name: 'Run History (1)' }).click();
  await expect(streaming.getByRole('table', { name: 'Transform run history' })).toBeVisible();
  await expect(streaming.getByText('run-stream-2026-11-17-001')).toBeVisible();
  await streaming.getByRole('tab', { name: 'Overview' }).click();
  await expect(streaming.getByText('Continuous', { exact: true }).first()).toBeVisible();
  await expect(streaming.getByText(/not exposed|no schedule data returned/i)).toHaveCount(0);

  await streaming.getByRole('button', { name: 'Close details' }).last().click();
  await rows.getByRole('button', { name: 'Details', exact: true }).nth(2).click();
  const legacy = page.getByRole('dialog', { name: 'Legacy Account Sync' });
  await expect(legacy).toBeVisible();
  await expect(legacy.getByText('Paused', { exact: true }).first()).toBeVisible();
  await expect(legacy.getByRole('tab', { name: 'Run History (1)' })).toBeVisible();
  await expect(legacy.getByText('Nightly at 03:00 UTC', { exact: true }).first()).toBeVisible();
});

test('transform detail shows an inventory summary while live detail is still loading', async ({ page }) => {
  await mockConnector(page, createConnectorState(), { transformDetailDelayMs: 2500 });
  await page.goto('/');
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Transform Explorer' }).click();
  const rows = page.getByRole('table', { name: 'Data Transform Explorer results' });
  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();

  const drawer = page.getByRole('dialog', { name: 'Normalize Contacts' });
  await expect(drawer.getByText('Loading live detail and run history…')).toBeVisible();
  await expect(drawer.getByText('Loading schedule from this org…')).toBeVisible();
  await expect(drawer.getByText('Normalize Contacts', { exact: true }).first()).toBeVisible();

  await drawer.getByRole('tab', { name: 'Flow & Lineage' }).click();
  await expect(drawer.getByText('Loading live lineage…')).toBeVisible();
  await drawer.getByRole('tab', { name: 'Definition', exact: true }).click();
  await expect(drawer.getByText('Loading live definition…')).toBeVisible();
  await expect(drawer.getByText(/No transform definition was returned/)).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Copy metadata JSON' })).toHaveCount(0);
  await drawer.getByRole('tab', { name: 'Run History', exact: true }).click();
  await expect(drawer.getByText('Loading run history from this org…')).toBeVisible();

  await expect(drawer.getByText('Loading live detail and run history…')).toHaveCount(0, { timeout: 10_000 });
  await expect(drawer.getByRole('tab', { name: 'Run History (2)' })).toBeVisible();
});

test('ERD Explorer shows the richer demo model and filters grounded edges', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'ERD Explorer' }).click();

  await expect(page.locator('h1')).toHaveText('ERD Explorer');
  await expect(page.getByText('8 objects', { exact: true })).toBeVisible();
  await expect(page.getByText('9 visible edges', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ERD canvas' })).toBeVisible();
  await expect(page.locator('.react-flow__node-erdObject')).toHaveCount(8);
  await expect(page.locator('.react-flow__edge')).toHaveCount(9);
  await expect(page.locator('.react-flow__node-erdObject').getByText('Order Item DMO', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole('region', { name: 'ERD canvas' })
    .getByRole('button', { name: 'Exit full screen' })
    .click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  await page.getByRole('button', { name: 'Confirmed', exact: true }).click();
  await expect(page.getByText('3 visible edges', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  await page.reload();
  await page.locator('.react-flow__node-erdObject').first().waitFor();
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('3 visible edges', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});

test('ERD canvas catches up when progressive discovery adds objects after mount', async ({ page }) => {
  const state = createConnectorState();
  await mockConnector(page, state);
  let sessionCalls = 0;
  const progress = {
    sessionId: 'progressive-session',
    generation: 'gen-1',
    state: 'running' as const,
    loaded: 1,
    total: 2,
    families: [],
    message: 'Loading model objects in small batches.',
  };
  await page.route('**/api/orgs/demo-uat/inventory/session**', (route: Route) => {
    sessionCalls += 1;
    const partial = {
      ...structuredClone(demoInventory),
      dmos: demoInventory.dmos.slice(0, 1),
      mappings: [],
      relationships: [],
      progress,
    };
    const complete = {
      ...structuredClone(demoInventory),
      progress: { ...progress, state: 'complete' as const, loaded: 2 },
    };
    return route.fulfill({
      json: { sessionId: 'progressive-session', snapshot: sessionCalls === 1 ? partial : complete },
    });
  });

  await page.goto('/erd');

  await expect(page.locator('.react-flow__node-erdObject')).toHaveCount(8);
  await expect(page.getByText('8 objects', { exact: true })).toBeVisible();
  expect(sessionCalls).toBeGreaterThanOrEqual(2);
});

test('navigating pages does not restart a fully loaded live inventory with gapped families', async ({ page }) => {
  await seedLiveMode(page);
  const state = createConnectorState();
  await mockConnector(page, state);
  let sessionCalls = 0;
  const partial = {
    ...structuredClone(state.inventories['prod-org']!),
    progress: {
      sessionId: 'gapped-session',
      generation: 'gen-1',
      state: 'partial' as const,
      loaded: 30,
      total: null,
      families: RESOURCE_FAMILIES.map((family) => ({
        family,
        status: 'complete' as const,
        loaded: 5,
        total: null,
        pagesFetched: 1,
        hasMore: false,
        error: null,
      })),
      message: 'Inventory loaded with gaps. The records that loaded are still available.',
    },
  };
  await page.route('**/api/orgs/prod-org/inventory/session**', (route: Route) => {
    sessionCalls += 1;
    return route.fulfill({ json: { sessionId: 'gapped-session', snapshot: partial } });
  });

  await page.goto('/');
  await expect(page.getByText('LIVE · PRODUCTION')).toBeVisible();
  await expect(page.getByText('30 records loaded so far').first()).toBeVisible();
  expect(sessionCalls).toBe(1);

  for (const name of ['Data Stream Explorer', 'DLO Explorer', 'Dashboard', 'Data Stream Explorer']) {
    await page.locator('#desktop-sidebar').getByRole('link', { name }).click();
    await expect(page.locator('h1')).toBeVisible();
  }
  expect(sessionCalls).toBe(1);
});

test('Data Lineage Explorer joins all metadata families and persists grounded filters', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Lineage Explorer' }).click();

  await expect(page.locator('h1')).toHaveText('Data Lineage Explorer');
  await expect(page.getByText('30 steps', { exact: true })).toBeVisible();
  await expect(page.getByText('43 visible links', { exact: true })).toBeVisible();
  await expect(page.getByText('0 gaps', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Data lineage canvas' })).toBeVisible();
  await expect(page.locator('.react-flow__node-lineageStep')).toHaveCount(30);
  await expect(page.locator('.react-flow__edge')).toHaveCount(43);
  await expect(page.locator('.react-flow__node-lineageStep').getByText('Normalize Contacts', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole('region', { name: 'Data lineage canvas' })
    .getByRole('button', { name: 'Exit full screen' })
    .click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  await page.getByRole('button', { name: 'Source-named', exact: true }).click();
  await expect(page.getByText('37 visible links', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(37);
  await expect(page.getByRole('button', { name: 'DCAT-derived', exact: true })).toHaveAttribute('aria-pressed', 'false');

  await page.reload();
  await page.locator('.react-flow__node-lineageStep').first().waitFor();
  await expect(page.getByRole('button', { name: 'Source-named', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('37 visible links', { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(37);
});

test('Change Impact Analyzer shows grounded impact for a deep-linked target and supports scope controls', async ({ page }) => {
  await openDemo(page);
  await page.goto('/change-impact?target=field:dlo:Account_DLO__dll:Industry&direction=downstream&depth=direct');

  await expect(page.locator('h1')).toHaveText('Change Impact Analyzer');
  await expect(page.locator('#main-content').getByRole('heading', { name: 'Change Impact Analyzer' })).toBeVisible();
  await expect(page.getByText('Direct dependencies')).toBeVisible();
  await expect(page.getByText('All reviewed paths')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Downstream' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1 hop' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Both directions' }).click();
  await expect(page.getByRole('button', { name: 'Both directions' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/direction=both/);

  await page.getByRole('button', { name: 'All paths' }).click();
  await expect(page.getByRole('button', { name: 'All paths' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/depth=all/);
  await expect(page.getByRole('link', { name: /Open in Data Lineage Explorer/i }).first()).toBeVisible();
});

test('contextual Analyze impact link opens Change Impact Analyzer for a field', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();

  const rows = page.getByRole('table', { name: 'DLO Explorer results' });
  await rows.getByRole('button', { name: 'Details', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /Fields \(/ }).click();

  await dialog.getByRole('table', { name: 'Object fields' }).getByRole('link', { name: 'Analyze impact' }).first().click();
  await expect(page.locator('h1')).toHaveText('Change Impact Analyzer');
  await expect(page).toHaveURL(/\/change-impact\?target=field/);
  await expect(page.getByText('Direct dependencies')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/dlos$/);
  await expect(page.getByRole('table', { name: 'DLO Explorer results' })).toBeVisible();

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Dictionary' }).click();
  await page.getByRole('table', { name: 'Data dictionary fields' }).getByRole('link', { name: 'Analyze impact' }).first().click();
  await expect(page).toHaveURL(/\/change-impact\?target=field/);

  await page.goBack();
  await expect(page).toHaveURL(/\/dictionary$/);
  await expect(page.getByRole('table', { name: 'Data dictionary fields' })).toBeVisible();
});

test('export menu consolidates local export formats', async ({ page }) => {
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Dictionary' }).click();

  const trigger = page.getByRole('button', { name: 'Export' });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.click();

  const menu = page.getByRole('menu', { name: 'Export' });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true);
  expect(await menu.evaluate((element) => Boolean(element.closest('#main-content')))).toBe(false);
  for (const format of ['CSV', 'JSON', 'Markdown']) {
    await expect(menu.getByRole('menuitem', { name: new RegExp(format) })).toBeVisible();
  }

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Help page answers common questions and maps them to explorers', async ({ page }) => {
  await openDemo(page);
  await page.locator('header').getByRole('button', { name: 'Help' }).click();

  await expect(page.locator('h1')).toHaveText('Help');
  await expect(page.getByRole('heading', { name: 'Help & documentation' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Start here' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('What do I need to get started?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Data Lineage Explorer' })).toBeVisible();

  await page.getByRole('tab', { name: 'Connect & refresh' }).click();
  await expect(page.getByText('Forbidden')).toBeVisible();

  await page.getByRole('tab', { name: 'Explore & trace' }).click();
  await expect(page.getByText('Named in metadata')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open' }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Glossary' }).click();
  await expect(page.getByText('Data Lake Object (DLO)')).toBeVisible();
  await expect(page.getByText('Discovery Health')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter glossary terms' }).fill('unified model');
  await expect(page.getByText(/Showing 1 of 13 terms/)).toBeVisible();
  await expect(page).toHaveURL(/topic=glossary/);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Glossary' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: 'Status & privacy' }).click();
  await expect(page.getByText(/Read metadata with allowlisted, read-only Salesforce CLI commands/)).toBeVisible();
  await expect(page.getByText('No hosted OAuth')).toBeVisible();
  await expect(page.getByText(/\/api\/auth\/\* routes are intentionally removed and return 404/)).toBeVisible();

  await page.getByRole('tab', { name: 'Contact' }).click();
  await expect(page.getByText('Ryan Joshua Dela Cruz')).toBeVisible();
  await expect(page.getByText('Technical Architect at Salesforce')).toBeVisible();
  await expect(page.getByText(/Created in a personal capacity/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read the product story' })).toBeVisible();
  await expect(page.getByText(/local-first, read-only workbench designed/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open GitHub Issues \(opens in a new tab\)/ })).toHaveAttribute(
    'href',
    'https://github.com/herethesavior/data-cloud-architect-toolkit/issues',
  );
  await expect(page.getByRole('link', { name: /Connect on LinkedIn \(opens in a new tab\)/ })).toHaveAttribute(
    'href',
    'https://www.linkedin.com/in/ryanjoshuadc',
  );

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Help' }).click();
  await expect(page.locator('h1')).toHaveText('Help');
});

test('leaving Help drops the stale topic before another visit', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Help' }).click();
  await page.getByRole('tab', { name: 'Glossary' }).click();
  await expect(page).toHaveURL(/topic=glossary/);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).not.toHaveURL(/topic=glossary/);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Help' }).click();
  await expect(page.getByRole('tab', { name: 'Start here' })).toHaveAttribute('aria-selected', 'true');
});

test('help tabs wrap on a phone and stay reachable by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Help' }).click();
  await expect(page.locator('h1')).toHaveText('Help');

  const tablist = page.getByRole('tablist', { name: 'Help topics' });
  const metrics = await tablist.evaluate((list) => ({ content: list.scrollWidth, viewport: list.clientWidth }));
  expect(metrics.content, 'tab strip should not scroll horizontally').toBeLessThanOrEqual(metrics.viewport);

  for (const name of [
    'Start here',
    'Connect & refresh',
    'Explore & trace',
    'Status & privacy',
    'Glossary',
    'Contact',
  ]) {
    const box = await page.getByRole('tab', { name }).boundingBox();
    expect(box, `${name} tab bounds`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  }

  await page.getByRole('tab', { name: 'Start here' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Contact' })).toBeFocused();
  await expect(page).toHaveURL(/topic=about/);
});

test('theme toggle switches to dark and persists across reloads', async ({ page }) => {
  await openDemo(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('appearance settings apply app-wide and persist across reloads', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('link', { name: 'Settings & Diagnostics' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

  const bodyFontSize = () => page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize));
  const panelPadding = () => page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.panel-pad');
    return panel ? Number.parseFloat(getComputedStyle(panel).paddingTop) : 0;
  });
  const brandColor = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim());

  const defaultFontSize = await bodyFontSize();
  const defaultPadding = await panelPadding();

  const appearancePanel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Appearance' }) });
  const panelBox = await appearancePanel.boundingBox();
  expect(panelBox).not.toBeNull();

  const expectSelectLabelsFit = async () => {
    const selections = await page.evaluate(() => {
      const measure = (id: string) => {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (!select) return { label: id, fits: false, insidePanel: false };
        const style = getComputedStyle(select);
        const box = select.getBoundingClientRect();
        const panel = select.closest('.panel')?.getBoundingClientRect();
        const context = document.createElement('canvas').getContext('2d');
        if (context) context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const label = select.options[select.selectedIndex]?.textContent?.trim() ?? '';
        const available = box.width
          - Number.parseFloat(style.paddingLeft)
          - Number.parseFloat(style.paddingRight)
          - Number.parseFloat(style.borderLeftWidth)
          - Number.parseFloat(style.borderRightWidth);
        return {
          label,
          fits: (context?.measureText(label).width ?? Infinity) <= available + 1,
          insidePanel: panel
            ? box.left >= panel.left - 1 && box.right <= panel.right + 1
              && box.top >= panel.top - 1 && box.bottom <= panel.bottom + 1
            : false,
        };
      };
      return [measure('appearance-font-size'), measure('appearance-density')];
    });
    for (const selection of selections) {
      expect(selection.fits, `${selection.label} fits its select`).toBe(true);
      expect(selection.insidePanel, `${selection.label} stays inside Appearance`).toBe(true);
    }
  };

  for (const control of [
    page.getByRole('group', { name: 'Dark palette' }),
    page.getByLabel('Font size'),
    page.getByLabel('Interface density'),
  ]) {
    const box = await control.boundingBox();
    expect(box, 'appearance control bounds').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x - 1);
    expect(box!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  }

  await page.getByRole('group', { name: 'Theme preference' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
  const forestBrand = await brandColor();

  await page.getByRole('group', { name: 'Dark palette' }).getByRole('button', { name: 'Midnight' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'midnight');
  expect(await brandColor(), 'midnight palette brand role').not.toBe(forestBrand);

  for (const size of ['small', 'medium', 'large'] as const) {
    await page.getByLabel('Font size').selectOption(size);
    await expect(page.locator('html')).toHaveAttribute('data-font-size', size);
    await expectSelectLabelsFit();
  }

  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expectSelectLabelsFit();
  await page.setViewportSize(desktopViewport);

  const largeFontSize = await bodyFontSize();
  expect(largeFontSize).toBeGreaterThan(defaultFontSize);

  await page.getByLabel('Interface density').selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await panelPadding()).toBeLessThan(defaultPadding);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'midnight');
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await bodyFontSize()).toBeCloseTo(largeFontSize, 1);

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'midnight');
  expect(await bodyFontSize()).toBeCloseTo(largeFontSize, 1);
});

test('header stays compact and groups workspace controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);

  const header = page.locator('header').first();
  const desktopHeight = (await header.boundingBox())?.height ?? 0;
  expect(desktopHeight).toBeLessThanOrEqual(80);
  await expect(header.getByRole('group', { name: 'Workspace context' })).toBeVisible();
  await expect(header.getByRole('group', { name: 'Utilities' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Search metadata' })).toBeVisible();
  await expect(header.getByLabel('Selected organization')).toBeVisible();
  await expect(header.getByText('DEMO DATA', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Open org connection details' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Help' })).toContainText('Help');
  await expect(header.locator('h1')).toHaveAttribute('title', 'Dashboard');
  await expect(header.getByRole('link', { name: 'DCAT home' })).toBeHidden();
  await expect(page.locator('#desktop-sidebar').getByRole('link', { name: 'DCAT home' })).toHaveAttribute('href', '/');

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneHeight = (await header.boundingBox())?.height ?? 0;
  expect(phoneHeight).toBeLessThanOrEqual(112);
  await expect(header.getByRole('link', { name: 'DCAT home' })).toBeVisible();
  const picker = header.getByLabel('Selected organization');
  await expect(picker).toBeVisible();
  expect(await picker.evaluate((element) => {
    const control = element.getBoundingClientRect();
    const bar = element.closest('header')!.getBoundingClientRect();
    return control.left >= bar.left && control.right <= bar.right && control.bottom <= bar.bottom;
  })).toBe(true);
});

test('brand mark is transparent and the header adapts across screen sizes', async ({ page }) => {
  const markResponse = await page.request.get('/dcat-mark.svg');
  expect(markResponse.ok()).toBeTruthy();
  const markSvg = await markResponse.text();
  expect(markSvg).toContain('viewBox="0 0 512 512"');
  expect(markSvg).not.toContain('<rect');
  expect(markSvg).not.toContain('linearGradient');

  await openDemo(page);
  const header = page.locator('header').first();
  await expect(header.locator('img.dcat-mark').first()).toHaveAttribute('src', '/dcat-icon-192.png');

  for (const width of [320, 390, 768, 1024, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('header')!;
      const barRect = bar.getBoundingClientRect();
      const context = bar.querySelector('.app-header-context')!;
      const picker = bar.querySelector('select')!.getBoundingClientRect();
      const contextControls = context.lastElementChild!.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll('button')].filter((button) => button.getBoundingClientRect().width > 0);
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headerHeight: barRect.height,
        contextHeight: context.getBoundingClientRect().height,
        minButtonHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
        orgPickerWidth: picker.width,
        orgPickerInsideHeader: picker.left >= barRect.left && picker.right <= barRect.right && picker.bottom <= barRect.bottom,
        pickerGapToControls: contextControls.left - picker.right,
      };
    });
    expect(metrics.overflow, `horizontal overflow at ${width}px`).toBe(0);
    expect(metrics.headerHeight, `header height at ${width}px`).toBeLessThanOrEqual(width < 640 ? 112 : 80);
    expect(metrics.contextHeight, `context height at ${width}px`).toBeLessThanOrEqual(56);
    expect(metrics.minButtonHeight, `touch target at ${width}px`).toBeGreaterThanOrEqual(36);
    expect(metrics.orgPickerWidth, `org picker width at ${width}px`).toBeGreaterThanOrEqual(width < 768 ? 140 : 72);
    expect(metrics.orgPickerInsideHeader, `org picker inside header at ${width}px`).toBe(true);
    if (width < 768) {
      expect(metrics.pickerGapToControls, `org picker gap to Demo Data at ${width}px`).toBeLessThanOrEqual(24);
    }
  }

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/change-impact');
  await expect(header.locator('h1')).toHaveText('Change Impact Analyzer');
  const titleFits = await header.locator('h1').evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(titleFits).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  const markFilter = await page.locator('#desktop-sidebar img.dcat-mark').evaluate((element) => getComputedStyle(element).filter);
  expect(markFilter).toContain('brightness');
});

test('desktop sidebar collapses to an icon rail and persists the choice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDemo(page);

  const sidebar = page.locator('#desktop-sidebar');
  const toggle = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-controls', 'desktop-sidebar');
  const expandedWidth = (await sidebar.boundingBox())?.width ?? 0;
  expect(expandedWidth).toBeGreaterThan(200);
  await expect(sidebar.locator('.nav-item svg').first()).toHaveAttribute('width', '18');
  await expect(sidebar.locator('nav > div > div[aria-hidden="true"]')).toHaveCount(0);
  const sidebarMotion = await sidebar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  expect(sidebarMotion.property).not.toContain('width');
  expect(parseFloat(sidebarMotion.duration)).toBe(0);

  await toggle.click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(sidebar.locator('img[src="/dcat-icon-192.png"]')).toBeVisible();
  const dloItem = sidebar.getByRole('link', { name: 'DLO Explorer' });
  await expect(dloItem).toBeVisible();
  await expect(sidebar.locator('.sidebar-label').first()).toBeHidden();
  await expect(sidebar.locator('.nav-item svg').first()).toHaveAttribute('width', '20');
  expect((await dloItem.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(sidebar.locator('nav > div > div[aria-hidden="true"]')).toHaveCount(3);
  await expect(sidebar.locator('.sidebar-footer-heading')).toHaveAttribute(
    'title',
    'Local-first - read-only metadata',
  );
  const collapsedWidth = (await sidebar.boundingBox())?.width ?? 0;
  expect(collapsedWidth).toBeLessThan(expandedWidth - 150);

  await page.reload();
  await expect(page.locator('#desktop-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.locator('#desktop-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.locator('#desktop-sidebar .sidebar-label').first()).toBeVisible();
  await expect(page.locator('#desktop-sidebar .nav-item svg').first()).toHaveAttribute('width', '18');
  await expect(page.locator('#desktop-sidebar nav > div > div[aria-hidden="true"]')).toHaveCount(0);
});

test('edition status stays visible while long pages scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await openDemo(page);
  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Data Dictionary' }).click();
  await expect(page.locator('h1')).toHaveText('Data Dictionary');

  const scrollY = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return window.scrollY;
  });
  expect(scrollY).toBeGreaterThan(0);

  const footer = page.locator('#desktop-sidebar .sidebar-footer');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText('Local-first');
  const box = await footer.boundingBox();
  expect(box, 'sidebar footer bounds').not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(521);
});

test('detail drawer contains keyboard focus and closes on Escape', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Explore the inventory' }).click();
  await page.getByRole('main').getByRole('button', { name: 'Details', exact: true }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Ctrl+K must not open the in-root palette over a portaled drawer.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search metadata' })).toHaveCount(0);
  await expect(dialog).toBeVisible();

  for (let press = 0; press < 12; press += 1) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('reduced motion disables transitions and entrance animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  // Wait for the elements whose computed styles are asserted. A loaded page
  // alone is not enough when the test workers are saturated.
  await expect(page.locator('#desktop-sidebar')).toBeVisible();
  await expect(page.locator('.page-enter').first()).toBeVisible();

  const durations = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('#desktop-sidebar');
    const pageContent = document.querySelector<HTMLElement>('.page-enter');
    return {
      sidebar: sidebar ? getComputedStyle(sidebar).transitionDuration : 'missing',
      page: pageContent ? getComputedStyle(pageContent).animationDuration : 'missing',
    };
  });
  const toMilliseconds = (value: string) => {
    const amount = parseFloat(value);
    return value.endsWith('ms') ? amount : amount * 1000;
  };
  expect(toMilliseconds(durations.sidebar)).toBeLessThan(1);
  expect(toMilliseconds(durations.page)).toBeLessThan(1);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'Settings & Diagnostics' }).click();
  const disclosure = page.locator('.disclosure-content').first();
  await expect(disclosure).toHaveCount(1);
  const disclosureDuration = await disclosure.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(toMilliseconds(disclosureDuration)).toBeLessThan(1);

  await page.locator('#desktop-sidebar').getByRole('link', { name: 'DLO Explorer' }).click();
  await page.getByRole('table', { name: 'DLO Explorer results' })
    .getByRole('button', { name: 'Details', exact: true })
    .first()
    .click();
  const drawer = page.getByTestId('drawer-panel');
  await expect(drawer).toBeVisible();
  const drawerDurations = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationDuration, width: style.transitionDuration };
  });
  expect(toMilliseconds(drawerDurations.animation)).toBeLessThan(1);
  expect(toMilliseconds(drawerDurations.width)).toBeLessThan(1);
});

test('layout has no horizontal overflow at laptop, tablet, and phone widths', async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 834, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openDemo(page);
    await expect(page.getByRole('button', { name: 'Explore the inventory' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);
  }
});

test('every screen fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await expect(page.getByRole('button', { name: 'Explore the inventory' })).toBeVisible();

  for (const name of [
    'Dashboard',
    'Org Connections',
    'Data Spaces',
    'DLO Explorer',
    'DMO Explorer',
    'Mapping Explorer',
    'Data Stream Explorer',
    'Data Transform Explorer',
    'ERD Explorer',
    'Data Lineage Explorer',
    'Change Impact Analyzer',
    'Data Dictionary',
    'Settings & Diagnostics',
    'Help',
    'About DCAT',
  ]) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name }).click();
    await expect(page.locator('h1')).toHaveText(name);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${name}`).toBeLessThanOrEqual(1);
  }
});

test('about page shows the story and a stable, navigable full-screen deck', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole('button', { name: 'Explore the inventory' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'About DCAT' }).click();
  await expect(page.locator('h1')).toHaveText('About DCAT');
  await expect(page.getByRole('heading', { name: 'About DCAT', level: 2 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/about');
  await expect(page.getByRole('navigation', { name: 'Chapters' }).getByRole('button')).toHaveCount(14);
  await expect(page.getByRole('navigation', { name: 'Chapters' }).getByRole('button', { name: /07 Handover/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Carry the architecture forward after Hypercare/ })).toBeVisible();
  await expect(page.locator('.story-flow').getByText(/Created in a personal capacity/)).toBeVisible();

  await page.getByRole('navigation', { name: 'Chapters' }).getByRole('button', { name: /04 Flow/ }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#story-scroll-flow');

  const deck = page.locator('.deck-shell');
  await page.getByRole('button', { name: 'Present' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(deck.locator('.deck-frame')).toBeVisible();
  await expect(deck.getByText('Data Cloud Architect Toolkit', { exact: true })).toBeVisible();
  await expect(deck.getByRole('link', { name: /Open DCAT/ })).toBeVisible();
  await expect(deck.locator('.deck-counter')).toContainText('01');
  const deckScroll = await page.evaluate(() => Math.round(window.scrollY));
  const slideHeights: number[] = [];
  const recordSlideHeight = async () => {
    const box = await deck.locator('.deck-slide').boundingBox();
    slideHeights.push(Math.round(box?.height ?? 0));
  };
  await recordSlideHeight();

  const slideTop = await deck.locator('.deck-slide').evaluate((element) => Math.round(element.getBoundingClientRect().top));
  await page.evaluate(() => {
    for (let index = 0; index < 13; index += 1) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: index > 0, bubbles: true }));
    }
  });
  await expect(deck.locator('.deck-counter')).toContainText('02');
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(deckScroll);
  expect(await deck.locator('.deck-slide').evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(slideTop);
  await expect.poll(() => new URL(page.url()).hash).toBe('#story-scroll-flow');

  await page.mouse.move(240, 320);
  await page.mouse.wheel(0, 600);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(deckScroll);

  await deck.getByRole('button', { name: 'Next slide' }).click();
  await expect(deck.locator('.deck-counter')).toContainText('03');
  await recordSlideHeight();
  await page.keyboard.press('ArrowRight');
  await expect(deck.locator('.deck-counter')).toContainText('04');
  await recordSlideHeight();

  const flowColumns = await deck.locator('.slide-flow-track').evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
  );
  expect(flowColumns, 'flow stage columns').toBe(3);
  const flowRows = await deck.locator('.slide-stage').evaluateAll(
    (nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top))).size,
  );
  expect(flowRows, 'flow stage rows').toBe(2);
  const flowBorders = await deck.locator('.slide-stage').evaluateAll(
    (nodes) => nodes.map((node) => getComputedStyle(node).borderTopWidth),
  );
  expect(flowBorders, 'flow stage borders').toEqual(Array(6).fill('0px'));

  await page.keyboard.press('End');
  await expect(deck.locator('.deck-counter')).toContainText('14');
  await recordSlideHeight();
  expect(new Set(slideHeights).size, `slide heights: ${slideHeights.join(', ')}`).toBe(1);

  await page.keyboard.press('Home');
  await expect(deck.locator('.deck-counter')).toContainText('01');
  const slideMetrics: {
    overflow: number; headHeight: number; hasFooterNote: boolean; fillGap: number;
    fit: number; clippedLead: boolean; cardSpill: number; bodyHorizontalOverflow: number;
    layout: string;
  }[] = [];
  for (let index = 0; index < 14; index += 1) {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    slideMetrics.push(await page.evaluate(() => {
      const slide = document.querySelector('.deck-slide') as HTMLElement;
      const body = slide.querySelector('.story-body') as HTMLElement;
      const head = slide.querySelector('.story-chapter-head') as HTMLElement;
      const children = [...body.children] as HTMLElement[];
      const bodyBottom = body.getBoundingClientRect().bottom;
      const cards = [...slide.querySelectorAll('.story-card, .story-step, .story-scenario, .story-roadmap-col, .slide-panel, .slide-capability, .slide-phase, .slide-stage, .slide-guardrail')] as HTMLElement[];
      const fit = Number(slide.style.getPropertyValue('--slide-fit') || '1');
      const cardSpill = Math.max(0, ...cards.flatMap((card) => {
        const inset = (Number.parseFloat(getComputedStyle(card).paddingBottom) || 0) * fit;
        const bottom = card.getBoundingClientRect().bottom - inset;
        return [...card.children].map((child) => Math.round(child.getBoundingClientRect().bottom - bottom));
      }));
      return {
        overflow: body.scrollHeight - body.clientHeight,
        headHeight: Math.round(head.getBoundingClientRect().height),
        hasFooterNote: Boolean(slide.querySelector(':scope > .story-chapter > .story-note')),
        fillGap: Math.round(bodyBottom - Math.max(...children.map((child) => child.getBoundingClientRect().bottom))),
        fit: Number(slide.style.getPropertyValue('--slide-fit') || '1'),
        clippedLead: [...slide.querySelectorAll('.story-lead')].some(
          (lead) => lead.scrollHeight > lead.clientHeight + 2 || lead.scrollWidth > lead.clientWidth + 2,
        ),
        cardSpill,
        bodyHorizontalOverflow: body.scrollWidth - body.clientWidth,
        layout: [...slide.querySelector('.story-chapter')?.classList ?? []]
          .find((name) => name.startsWith('present-layout-'))
          ?.replace('present-layout-', '') ?? '',
      };
    }));
    if (index < 13) {
      await page.keyboard.press('ArrowRight');
      await expect(deck.locator('.deck-counter')).toContainText(String(index + 2).padStart(2, '0'));
    }
  }
  for (const [index, metrics] of slideMetrics.entries()) {
    expect(metrics.overflow, `slide ${index + 1} body overflow`).toBeLessThanOrEqual(1);
    expect(metrics.hasFooterNote, `slide ${index + 1} footer note`).toBe(true);
    expect(metrics.fillGap, `slide ${index + 1} content fill gap`).toBeLessThanOrEqual(24);
    expect(metrics.fit, `slide ${index + 1} fit floor`).toBeGreaterThanOrEqual(0.6);
    expect(metrics.clippedLead, `slide ${index + 1} clipped lead`).toBe(false);
    expect(metrics.cardSpill, `slide ${index + 1} card content spill`).toBeLessThanOrEqual(2);
    expect(metrics.bodyHorizontalOverflow, `slide ${index + 1} body horizontal overflow`).toBeLessThanOrEqual(1);
  }
  const headHeights = slideMetrics.map((metrics) => metrics.headHeight);
  expect(Math.max(...headHeights) - Math.min(...headHeights), `head heights: ${headHeights.join(', ')}`).toBeLessThanOrEqual(100);
  expect(slideMetrics.map((metrics) => metrics.layout)).toEqual([
    'cover',
    'diagnosis',
    'capabilities',
    'flow',
    'process',
    'alignment',
    'timeline',
    'roles',
    'evidence',
    'guardrails',
    'measures',
    'roadmap',
    'demo',
    'takeaway',
  ]);

  await deck.getByRole('button', { name: 'Exit presentation' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByRole('button', { name: 'Present' })).toBeFocused();
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(deckScroll);
});

test('about deck icon and text scale stays consistent across repeated motifs', async ({ page }) => {
  type IconMetrics = {
    layout: string;
    visualNodeWidth: number | null;
    artClipped: boolean;
    artWidthRatio: number;
    artHeightRatio: number;
    iconWidths: number[];
    iconAlignments: string[];
    cardAlignments: string[];
    cardTextAlignments: string[];
    coverSummary: string | null;
    stageStrong: number | null;
    stageSpan: number | null;
  };

  await openDemo(page);
  await page.goto('/about');
  await expect(page.getByRole('button', { name: 'Present' })).toBeVisible();
  await page.getByRole('button', { name: 'Present' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  const slideMetrics: IconMetrics[] = [];
  for (let index = 0; index < 14; index += 1) {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    slideMetrics.push(await page.evaluate(() => {
      const slide = document.querySelector('.deck-slide') as HTMLElement;
      const chapter = slide.querySelector('.story-chapter') as HTMLElement;
      const fit = Number(slide.style.getPropertyValue('--slide-fit') || '1');
      const width = (element: Element) => Math.round(element.getBoundingClientRect().width / fit);
      const icons = [...slide.querySelectorAll('svg')].filter((svg) => !svg.classList.contains('story-art'));
      const stageStrong = slide.querySelector('.slide-stage strong');
      const stageSpan = slide.querySelector('.slide-stage span');
      const art = slide.querySelector('.slide-visual .story-art');
      let artClipped = false;
      let artWidthRatio = 0;
      let artHeightRatio = 0;
      if (art) {
        const artBox = art.getBoundingClientRect();
        const shapes = [...art.querySelectorAll('rect, text, path, circle')]
          .filter((shape) => !shape.closest('defs'))
          .map((shape) => shape.getBoundingClientRect());
        if (shapes.length > 0) {
          const left = Math.min(...shapes.map((shape) => shape.left));
          const right = Math.max(...shapes.map((shape) => shape.right));
          const top = Math.min(...shapes.map((shape) => shape.top));
          const bottom = Math.max(...shapes.map((shape) => shape.bottom));
          artClipped = shapes.some((shape) =>
            shape.left < artBox.left - 1 || shape.right > artBox.right + 1
            || shape.top < artBox.top - 1 || shape.bottom > artBox.bottom + 1);
          artWidthRatio = (right - left) / artBox.width;
          artHeightRatio = (bottom - top) / artBox.height;
        }
      }
      return {
        layout: [...chapter.classList].find((name) => name.startsWith('present-layout-'))?.replace('present-layout-', '') ?? '',
        visualNodeWidth: slide.querySelector('.story-art rect') ? width(slide.querySelector('.story-art rect')!) : null,
        artClipped,
        artWidthRatio,
        artHeightRatio,
        iconWidths: icons.map(width),
        iconAlignments: [...slide.querySelectorAll('.slide-stage-icon, .slide-capability > svg')]
          .map((icon) => getComputedStyle(icon).alignSelf),
        cardAlignments: [...slide.querySelectorAll('.slide-capability, .slide-stage')]
          .map((card) => getComputedStyle(card).alignItems),
        cardTextAlignments: [...slide.querySelectorAll('.slide-capability, .slide-stage')]
          .map((card) => getComputedStyle(card).textAlign),
        coverSummary: slide.querySelector('.slide-cover-summary')?.textContent?.trim() ?? null,
        stageStrong: stageStrong ? Number.parseFloat(getComputedStyle(stageStrong).fontSize) : null,
        stageSpan: stageSpan ? Number.parseFloat(getComputedStyle(stageSpan).fontSize) : null,
      };
    }));
    if (index < 13) await page.keyboard.press('ArrowRight');
  }

  const byLayout = new Map(slideMetrics.map((metrics) => [metrics.layout, metrics]));
  for (const [layout, expectedWidth] of [
    ['capabilities', 40],
    ['flow', 32],
    ['alignment', 16],
    ['guardrails', 28],
    ['takeaway', 28],
  ] as const) {
    const metrics = byLayout.get(layout)!;
    expect(metrics.iconWidths.length, `${layout} icon count`).toBeGreaterThan(0);
    expect(new Set(metrics.iconWidths), `${layout} icon widths`).toEqual(new Set([expectedWidth]));
  }
  for (const layout of ['capabilities', 'flow']) {
    const metrics = byLayout.get(layout)!;
    expect(metrics.iconAlignments.length, `${layout} icon alignment count`).toBeGreaterThan(0);
    expect(new Set(metrics.iconAlignments), `${layout} icon alignment`).toEqual(new Set(['center']));
    expect(new Set(metrics.cardAlignments), `${layout} card content alignment`).toEqual(new Set(['center']));
    expect(new Set(metrics.cardTextAlignments), `${layout} card text alignment`).toEqual(new Set(['center']));
  }
  expect(byLayout.get('cover')!.coverSummary, 'cover DCAT summary').toMatch(/Data Cloud architecture/i);
  const cover = byLayout.get('cover')!;
  expect(cover.artClipped, 'cover diagram clipping').toBe(false);
  expect(cover.artWidthRatio, 'cover diagram width use').toBeGreaterThan(0.9);
  expect(cover.artHeightRatio, 'cover diagram height use').toBeGreaterThan(0.8);
  expect(cover.visualNodeWidth, 'cover diagram node width').toBeGreaterThan(100);
  expect(byLayout.get('flow')!.stageStrong, 'flow stage title size').toBeGreaterThanOrEqual(20);
  expect(byLayout.get('flow')!.stageSpan, 'flow stage detail size').toBeGreaterThanOrEqual(18);
});

test('cover architecture diagram visibly connects the presentation nodes', async ({ page }) => {
  await openDemo(page);
  await page.goto('/about');
  await page.getByRole('button', { name: 'Present' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  const diagram = await page.locator('.slide-visual .story-art').evaluate((art) => {
    const rects = [...art.querySelectorAll('rect')].map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      width: Number(rect.getAttribute('width')),
      height: Number(rect.getAttribute('height')),
    }));
    const edges = [...art.querySelectorAll('g[stroke] path')];
    const endpoints = edges.map((edge) => {
      const point = edge.getPointAtLength(edge.getTotalLength());
      return { x: Math.round(point.x), y: Math.round(point.y) };
    });
    const touchesNode = (point: { x: number; y: number }) => rects.some((rect) => {
      const withinX = point.x >= rect.x - 2 && point.x <= rect.x + rect.width + 2;
      const withinY = point.y >= rect.y - 2 && point.y <= rect.y + rect.height + 2;
      const onVerticalEdge = Math.abs(point.x - rect.x) <= 2
        || Math.abs(point.x - (rect.x + rect.width)) <= 2;
      const onHorizontalEdge = Math.abs(point.y - rect.y) <= 2
        || Math.abs(point.y - (rect.y + rect.height)) <= 2;
      return withinX && withinY && (onVerticalEdge || onHorizontalEdge);
    });
    return {
      nodeCount: rects.length,
      edgeCount: edges.length,
      arrowCount: edges.filter((edge) => edge.getAttribute('marker-end')).length,
      gradientUnits: art.querySelector('#dcat-architecture-edge')?.getAttribute('gradientUnits') ?? null,
      strokeWidth: edges[0] ? Number.parseFloat(getComputedStyle(edges[0]).strokeWidth) : 0,
      allEndpointsTouchNodes: endpoints.every(touchesNode),
    };
  });

  expect(diagram.nodeCount, 'architecture nodes').toBe(7);
  expect(diagram.edgeCount, 'architecture connectors').toBe(8);
  expect(diagram.arrowCount, 'directional architecture connectors').toBe(7);
  expect(diagram.gradientUnits, 'architecture connector gradient').toBe('userSpaceOnUse');
  expect(diagram.strokeWidth, 'architecture connector stroke width').toBeGreaterThanOrEqual(2);
  expect(diagram.allEndpointsTouchNodes, 'architecture connector endpoints').toBe(true);
});

test('about deck slides stay legible and scrollable on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await page.goto('/about');
  await expect(page.getByRole('button', { name: 'Present' })).toBeVisible();

  const deck = page.locator('.deck-shell');
  await page.getByRole('button', { name: 'Present' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  const minFonts: number[] = [];
  const cardSpills: number[] = [];
  const clippedLeads: boolean[] = [];
  const clippedArt: boolean[] = [];
  const scrollContainers: boolean[] = [];
  for (let index = 0; index < 14; index += 1) {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const metrics = await page.evaluate(() => {
      const slide = document.querySelector('.deck-slide') as HTMLElement;
      const body = slide.querySelector('.story-body') as HTMLElement;
      const cards = [...slide.querySelectorAll('.story-card, .story-step, .story-scenario, .story-roadmap-col, .slide-panel, .slide-capability, .slide-phase, .slide-stage, .slide-guardrail')] as HTMLElement[];
      const cardSpill = Math.max(0, ...cards.flatMap((card) => {
        const inset = Number.parseFloat(getComputedStyle(card).paddingBottom) || 0;
        const bottom = card.getBoundingClientRect().bottom - inset;
        return [...card.children].map((child) => Math.round(child.getBoundingClientRect().bottom - bottom));
      }));
      const textElements = [...slide.querySelectorAll('p, span, strong, h3, h4, li, small')].filter((element) => {
        if (!element.textContent?.trim()) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      });
      const art = slide.querySelector('.slide-visual .story-art');
      let artClipped = false;
      if (art) {
        const artBox = art.getBoundingClientRect();
        const shapes = [...art.querySelectorAll('rect, text, path, circle')]
          .filter((shape) => !shape.closest('defs'))
          .map((shape) => shape.getBoundingClientRect());
        artClipped = shapes.some((shape) =>
          shape.left < artBox.left - 1 || shape.right > artBox.right + 1
          || shape.top < artBox.top - 1 || shape.bottom > artBox.bottom + 1);
      }
      return {
        artClipped,
        minFont: Math.min(...textElements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize))),
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyHorizontalOverflow: body.scrollWidth - body.clientWidth,
        cardSpill,
        clippedLead: [...slide.querySelectorAll('.story-lead')].some(
          (lead) => lead.scrollHeight > lead.clientHeight + 2 || lead.scrollWidth > lead.clientWidth + 2,
        ),
        scrolls: getComputedStyle(body).overflowY === 'auto' && body.scrollHeight >= body.clientHeight,
      };
    });
    minFonts.push(metrics.minFont);
    cardSpills.push(metrics.cardSpill);
    clippedLeads.push(metrics.clippedLead);
    clippedArt.push(metrics.artClipped);
    scrollContainers.push(metrics.scrolls);
    expect(metrics.horizontalOverflow, `horizontal overflow on slide ${index + 1}`).toBeLessThanOrEqual(1);
    expect(metrics.bodyHorizontalOverflow, `body horizontal overflow on slide ${index + 1}`).toBeLessThanOrEqual(1);
    if (index < 13) {
      await page.keyboard.press('ArrowRight');
      await expect(deck.locator('.deck-counter')).toContainText(String(index + 2).padStart(2, '0'));
    }
  }
  expect(Math.min(...minFonts), `rendered font sizes: ${minFonts.join(', ')}`).toBeGreaterThanOrEqual(10);
  expect(Math.max(...cardSpills), `card content spill: ${cardSpills.join(', ')}`).toBeLessThanOrEqual(2);
  expect(clippedLeads.some(Boolean), `clipped leads: ${clippedLeads.join(', ')}`).toBe(false);
  expect(clippedArt.some(Boolean), `clipped cover diagram: ${clippedArt.join(', ')}`).toBe(false);
  expect(scrollContainers.every(Boolean), `body scroll containers: ${scrollContainers.join(', ')}`).toBe(true);

  await deck.getByRole('button', { name: 'Exit presentation' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test('about chapter deep links restore the target section on a direct load', async ({ page }) => {
  await openDemo(page);
  await page.goto('/about#story-scroll-flow');

  await expect(page.locator('h1')).toHaveText('About DCAT');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
});

test('command palette opens with Ctrl+K and opens a DLO detail drawer', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole('button', { name: 'Explore the inventory' })).toBeVisible();
  await page.keyboard.press('Control+k');

  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Search inventory metadata' });
  await expect(input).toBeFocused();

  await input.fill('Account DLO');
  const option = palette.getByRole('option').filter({ hasText: 'Account DLO' }).first();
  await expect(option).toContainText('DLO');
  await expect(option).toContainText('Account_DLO__dll');
  await expect(option).toContainText('default');
  await option.click();

  await expect(page.locator('h1')).toHaveText('DLO Explorer');
  const drawer = page.getByRole('dialog', { name: 'Account DLO' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('DLO Explorer / Account DLO')).toBeVisible();
});

test('command palette Enter selects a DMO and navigates to its explorer', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Search metadata' }).click();

  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  const input = palette.getByRole('combobox', { name: 'Search inventory metadata' });
  await input.fill('Click Event DMO');
  await expect(palette.getByRole('option').filter({ hasText: 'Click Event DMO' })).toHaveCount(1);
  await input.press('Enter');

  await expect(page.locator('h1')).toHaveText('DMO Explorer');
  const drawer = page.getByRole('dialog', { name: 'Click Event DMO' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('DMO Explorer / Click Event DMO')).toBeVisible();
});

test('command palette opens stream results in the Data Stream Explorer', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDemo(page);
  await page.getByRole('button', { name: 'Search metadata' }).click();

  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  await palette.getByRole('combobox', { name: 'Search inventory metadata' }).fill('Accounts Stream');
  await page.keyboard.press('Enter');

  await expect(page.locator('h1')).toHaveText('Data Stream Explorer');
  const drawer = page.getByRole('dialog', { name: 'Accounts Stream' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Data Stream Explorer / Accounts Stream')).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Target DLO' })).toBeVisible();
  await expect(drawer.getByText('Salesforce CRM', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Demo Salesforce Org', { exact: true })).toBeVisible();

  await drawer.getByRole('tab', { name: 'Raw Metadata' }).click();
  await expect(drawer.getByText(/"apiName": "Accounts_Stream"/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Copy metadata JSON' }).click();
  await expect(drawer.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"apiName": "Accounts_Stream"');
});

test('command palette opens transform results in the Data Transform Explorer', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Search metadata' }).click();

  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  const input = palette.getByRole('combobox', { name: 'Search inventory metadata' });
  await input.fill('Normalize Contacts');
  await expect(palette.getByRole('option').filter({ hasText: 'Normalize Contacts' })).toHaveCount(1);
  await input.press('Enter');

  await expect(page.locator('h1')).toHaveText('Data Transform Explorer');
  const drawer = page.getByRole('dialog', { name: 'Normalize Contacts' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Data Transform Explorer / Normalize Contacts')).toBeVisible();
});

test('command palette no-inventory state leads with org selection and demo fallback', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  state.orgs = [];
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/');

  await page.getByRole('button', { name: 'Search metadata' }).click();
  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  await expect(palette.getByText('No inventory available')).toBeVisible();
  await expect(palette.getByRole('button', { name: 'Select an org' })).toBeVisible();
  await expect(palette.getByRole('button', { name: 'Use demo mode' })).toBeVisible();
});

test('rapid mode toggles queue only one switch and settle in the requested mode', async ({ page }) => {
  const state = createConnectorState();
  const modeCalls: string[] = [];
  await mockConnector(page, state, { modeDelayMs: 500, modeCalls });
  await page.goto('/');
  await expect(page.getByText('Sample inventory')).toBeVisible();

  const toggle = page.locator('header').getByRole('button', { name: 'Switch to live mode' });
  await toggle.evaluate((button) => {
    button.click();
    button.click();
    button.click();
  });

  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await expect(page.getByText('Live org metadata')).toBeVisible();
  expect(modeCalls).toEqual(['live']);
  await expect(page.locator('header').getByRole('button', { name: 'Switch to demo mode' })).toBeEnabled();
});

test('a refresh started before a mode switch cannot repopulate the old context', async ({ page }) => {
  const state = createConnectorState();
  await mockConnector(page, state);
  await page.goto('/');
  await expect(page.getByText('Sample inventory')).toBeVisible();

  let refreshCompleted = false;
  await page.route('**/api/orgs/*/inventory/session', async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ json: { sessionId: 'e2e-session', snapshot: demoInventory } });
    refreshCompleted = true;
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByRole('img', { name: 'Inventory loading' })).toBeVisible();
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to live mode' }).click();

  await expect(page.locator('header').getByText('LIVE · PRODUCTION', { exact: true })).toBeVisible();
  await expect(page.getByText('Live org metadata')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Inventory loading' })).toHaveCount(0);
  await expect(page.getByText('Sample inventory')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => refreshCompleted).toBe(true);
  expect(pageErrors).toEqual([]);

  await page.getByRole('button', { name: 'Switch to demo mode' }).click();
  await expect(page.getByText('Sample inventory')).toBeVisible();
  await expect(page.getByText('Live org metadata')).toHaveCount(0);
});

test('pending mode switches keep every demo recovery path disabled and single-shot', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  state.orgs = [];
  const modeCalls: string[] = [];
  await seedLiveMode(page);
  await mockConnector(page, state, { modeDelayMs: 600, modeCalls });
  await page.goto('/');

  await expect(page.locator('header').getByText('LIVE · NOT CONNECTED', { exact: true })).toBeVisible();
  const headerRecovery = page.locator('header').getByRole('button', { name: 'Switch to demo mode' });
  await headerRecovery.click();
  await expect(headerRecovery).toBeDisabled();

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search metadata' });
  await expect(palette.getByRole('button', { name: 'Use demo mode' })).toBeDisabled();

  await expect(page.getByText('Sample inventory')).toBeVisible();
  expect(modeCalls).toEqual(['demo']);
});

test('browser history during a live org switch keeps the selected context', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  await seedLiveMode(page);
  await mockConnector(page, state);
  await page.goto('/dlos');

  const rows = page.getByRole('table', { name: 'DLO Explorer results' });
  await expect(rows.getByText('Production Account')).toBeVisible();
  await page.getByLabel('Selected organization').selectOption('sandbox-org');
  await expect(page.locator('h1')).toHaveText('Dashboard');

  await page.goBack();
  await expect(page.locator('h1')).toHaveText('DLO Explorer');
  await expect(rows.getByText('Sandbox Account')).toBeVisible();
  await expect(rows.getByText('Production Account')).toHaveCount(0);

  await page.goForward();
  await expect(page.locator('h1')).toHaveText('Dashboard');
  await expect(page.getByText('Sandbox Account')).toHaveCount(0);
});

test('a failed refresh does not follow the user into another org', async ({ page }) => {
  const state = createConnectorState();
  state.mode = 'live';
  await seedLiveMode(page);
  await mockConnector(page, state);
  let failRefresh = false;
  await page.route('**/api/orgs/*/inventory/session', async (route: Route) => {
    const url = new URL(route.request().url());
    const alias = decodeURIComponent(url.pathname.split('/').filter(Boolean)[2] ?? '');
    if (failRefresh && alias === 'prod-org') {
      await route.fulfill({
        status: 500,
        json: { error: { code: 'COMMAND_FAILED', message: 'Production CLI is unavailable.' } },
      });
      return;
    }
    const inventory = state.inventories[alias] ?? demoInventory;
    await route.fulfill({ json: { sessionId: 'e2e-session', snapshot: inventory } });
  });
  await page.goto('/');

  const picker = page.getByLabel('Selected organization');
  await expect(picker).toHaveValue('prod-org');
  await expect(page.getByRole('button', { name: 'Refresh inventory' })).toBeVisible();
  failRefresh = true;
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByRole('alert')).toContainText(/Refresh failed: We couldn't load this org's metadata\./);

  await picker.selectOption('sandbox-org');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
