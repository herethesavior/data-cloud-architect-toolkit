import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
