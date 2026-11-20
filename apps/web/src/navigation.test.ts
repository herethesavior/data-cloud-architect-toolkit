// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  isLegacyPageHash,
  pageFromLocation,
  pageFromPath,
  pageHref,
  pagePath,
  pageUrl,
  writePagePath,
} from './navigation.ts';

describe('path navigation', () => {
  it('maps real paths and treats unknown paths as Dashboard', () => {
    expect(pageFromPath('/')).toBe('dashboard');
    expect(pageFromPath('/dlos')).toBe('dlos');
    expect(pageFromPath('/data-streams/')).toBe('data-streams');
    expect(pageFromPath('/DOES-NOT-EXIST')).toBe('dashboard');
  });

  it('gives every menu item a crawlable href', () => {
    expect(pagePath('dashboard')).toBe('/');
    expect(pageHref('dashboard')).toBe('/');
    expect(pageHref('orgs')).toBe('/orgs');
    expect(pageHref('data-transforms')).toBe('/data-transforms');
    expect(pageHref('change-impact')).toBe('/change-impact');
    expect(pageHref('about')).toBe('/about');
  });

  it('accepts legacy page fragments only when there is no matching path', () => {
    expect(pageFromLocation({ pathname: '/', hash: '' })).toBe('dashboard');
    expect(pageFromLocation({ pathname: '/', hash: '#dlos' })).toBe('dlos');
    expect(pageFromLocation({ pathname: '/', hash: '#/data-streams' })).toBe('data-streams');
    expect(pageFromLocation({ pathname: '/', hash: '#about' })).toBe('about');
    expect(pageFromLocation({ pathname: '/', hash: '#main-content' })).toBe('dashboard');
    expect(pageFromLocation({ pathname: '/help', hash: '#dlos' })).toBe('help');
    expect(isLegacyPageHash('#dlos')).toBe(true);
    expect(isLegacyPageHash('#main-content')).toBe(false);
  });

  it('rewrites the path while preserving query state and clearing fragments', () => {
    const url = pageUrl('dlos', 'https://sfdcat.pages.dev/help?topic=glossary#old');

    expect(url).toBe('/dlos?topic=glossary');
    expect(pageUrl('dashboard', 'https://sfdcat.pages.dev/dlos?view=compact#dlos')).toBe('/?view=compact');
  });

  it('pushes and replaces the URL path without a page reload', () => {
    window.history.replaceState(null, '', '/?view=compact#dlos');

    writePagePath('dashboard');
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?view=compact');

    writePagePath('settings', 'replace');
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('?view=compact');
  });
});
