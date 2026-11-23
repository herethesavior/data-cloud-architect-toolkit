import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSfShim } from './run.ts';

describe('resolveSfShim', () => {
  it('extracts the Node entry point from a Salesforce CLI .cmd shim without a shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcat-shim-'));
    const runScript = join(dir, 'run');
    writeFileSync(runScript, '');
    const shim = join(dir, 'sf.cmd');
    const nodeExe = join(dir, 'node.exe');
    writeFileSync(shim, `@echo off\n"%nodepath%" --no-deprecation "%~dp0run" %*\n`.replace('%nodepath%', nodeExe));

    // The node.exe file itself does not need to exist for the regex assertion;
    // create it so the resolver's existence checks pass.
    writeFileSync(nodeExe, '');

    const resolved = resolveSfShim(shim);
    expect(resolved?.command).toBe(nodeExe);
    expect(resolved?.prefixArgs).toEqual(['--no-deprecation', join(dir, 'run')]);
  });

  it('follows environment-variable redirects to the active CLI install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcat-shim-redirect-'));
    const activeDir = mkdtempSync(join(tmpdir(), 'dcat-cli-active-'));
    const envName = 'DCAT_TEST_SF_HOME';
    process.env[envName] = activeDir;
    const redirect = `%${envName}%${sep}sf.cmd`;
    try {
      const versionDir = join(activeDir, '2.0.0');
      mkdirSync(versionDir, { recursive: true });
      const activeNode = join(versionDir, 'node.exe');
      const activeRun = join(versionDir, 'run');
      writeFileSync(activeNode, '');
      writeFileSync(activeRun, '');
      writeFileSync(
        join(versionDir, 'sf.cmd'),
        `@echo off\n"${activeNode}" --no-deprecation "${activeRun}" %*\n`,
      );
      writeFileSync(
        join(activeDir, 'sf.cmd'),
        `@echo off\n"${'%~dp0'}${join('2.0.0', 'sf.cmd')}" %*\n`,
      );

      const legacyNode = join(dir, 'node.exe');
      const legacyRun = join(dir, 'run');
      writeFileSync(legacyNode, '');
      writeFileSync(legacyRun, '');
      const shim = join(dir, 'sf.cmd');
      writeFileSync(
        shim,
        [
          '@echo off',
          `if exist "${redirect}" (`,
          `  "${redirect}" %*`,
          ') else (',
          `  "${legacyNode}" --no-deprecation "${legacyRun}" %*`,
          ')',
          '',
        ].join('\n'),
      );

      const resolved = resolveSfShim(shim);
      expect(resolved?.command).toBe(activeNode);
      expect(resolved?.prefixArgs).toEqual(['--no-deprecation', activeRun]);
    } finally {
      delete process.env[envName];
    }
  });
});
