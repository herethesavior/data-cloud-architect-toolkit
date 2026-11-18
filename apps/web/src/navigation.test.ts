// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pageFromHash, pageHref, pageUrl, writePageHash } from './navigation.ts';

describe('hash navigation', () => {
  it('maps page fragments and treats unknown hashes as Dashboard', () => {
    expect(pageFromHash('')).toBe('dashboard');
    expect(pageFromHash('#dlos')).toBe('dlos');
    expect(pageFromHash('#/data-streams')).toBe('data-streams');
    expect(pageFromHash('#does-not-exist')).toBe('dashboard');
    expect(pageFromHash('#main-content')).toBe('dashboard');
  });

  it('keeps Dashboard links clean and every other menu item addressable', () => {
    expect(pageHref('dashboard')).toBe('./');
    expect(pageHref('orgs')).toBe('#orgs');
    expect(pageHref('data-transforms')).toBe('#data-transforms');
  });

  it('preserves path and query while rewriting the page fragment', () => {
    const url = pageUrl('dlos', 'https://sfdcat.pages.dev/workbench/?view=compact#old');

    expect(url).toBe('/workbench/?view=compact#dlos');
    expect(pageUrl('dashboard', 'https://sfdcat.pages.dev/workbench/?view=compact#dlos')).toBe(
      '/workbench/?view=compact',
    );
  });

  it('pushes and replaces the URL fragment without a page reload', () => {
    window.history.replaceState(null, '', '/workbench/?view=compact#dlos');

    writePageHash('dashboard');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?view=compact');

    writePageHash('settings', 'replace');
    expect(window.location.hash).toBe('#settings');
    expect(window.location.search).toBe('?view=compact');
  });
});
