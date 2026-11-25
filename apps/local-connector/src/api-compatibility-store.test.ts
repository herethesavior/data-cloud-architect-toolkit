import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiVersionSelection, saveApiVersionSelection } from './api-compatibility-store.ts';

const directories: string[] = [];

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dcat-compatibility-'));
  directories.push(directory);
  return join(directory, 'api-compatibility.json');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('bridge-local API compatibility store', () => {
  it('returns the recommended default when no setting has been saved', () => {
    expect(loadApiVersionSelection(tempPath())).toEqual({ mode: 'recommended' });
  });

  it('round-trips a curated selection', () => {
    const path = tempPath();
    saveApiVersionSelection(path, { mode: 'specific', version: '68.0' });

    expect(loadApiVersionSelection(path)).toEqual({ mode: 'specific', version: '68.0' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mode: 'specific', version: '68.0' });
  });

  it('reports a friendly, non-technical failure when the setting cannot be written', () => {
    const blockedParent = tempPath();
    writeFileSync(blockedParent, 'not a directory', 'utf8');

    expect(() => saveApiVersionSelection(join(blockedParent, 'child.json'), { mode: 'latest' }))
      .toThrow("We couldn't save the API version on this computer. Try again.");
    try {
      saveApiVersionSelection(join(blockedParent, 'child.json'), { mode: 'latest' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMPATIBILITY_SAVE_FAILED' });
    }
  });

  it('falls back safely when the saved file is malformed', () => {
    const path = tempPath();
    writeFileSync(path, '{not json', 'utf8');

    expect(loadApiVersionSelection(path)).toEqual({ mode: 'recommended' });
  });
});
