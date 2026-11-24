import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NodeProcessRunner, resolveSfShim } from './run.ts';

type SpawnFn = ConstructorParameters<typeof NodeProcessRunner>[1];

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('close', null);
    return true;
  });
  return child;
}

function childSpawner(children: FakeChild[]): SpawnFn {
  return (() => {
    const child = fakeChild();
    children.push(child);
    return child;
  }) as unknown as SpawnFn;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const localResolver = async () => ({ command: 'sf', prefixArgs: [] });

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

describe('NodeProcessRunner queue', () => {
  it('runs one CLI process at a time and survives a failed command', async () => {
    const children: FakeChild[] = [];
    const runner = new NodeProcessRunner('sf', childSpawner(children), localResolver);
    const first = runner.run(['first']);
    const second = runner.run(['second']);
    await tick();

    expect(children).toHaveLength(1);
    children[0]!.emit('error', new Error('boom'));
    await expect(first).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    await tick();
    expect(children).toHaveLength(2);
    children[1]!.emit('close', 0);
    await expect(second).resolves.toMatchObject({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('does not spawn a queued command after its caller aborts', async () => {
    const children: FakeChild[] = [];
    const runner = new NodeProcessRunner('sf', childSpawner(children), localResolver);
    const controller = new AbortController();
    const first = runner.run(['first']);
    const queued = runner.run(['queued'], { signal: controller.signal });
    await tick();

    expect(children).toHaveLength(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'TIMEOUT' });

    children[0]!.emit('close', 0);
    await first;
    const third = runner.run(['third']);
    await tick();
    expect(children).toHaveLength(2);
    expect(children[1]!.kill).not.toHaveBeenCalled();
    children[1]!.emit('close', 0);
    await third;
  });

  it('starts a queued command timeout only after dequeue', async () => {
    const children: FakeChild[] = [];
    const runner = new NodeProcessRunner('sf', childSpawner(children), localResolver);
    const first = runner.run(['first'], { timeoutMs: 1_000 });
    const second = runner.run(['second'], { timeoutMs: 5 });
    await tick();

    expect(children).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(1);

    children[0]!.emit('close', 0);
    await first;
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.emit('close', 0);
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
  });

  it('unwedges the queue when a killed CLI never emits close', async () => {
    const children: FakeChild[] = [];
    const spawner = (() => {
      const child = fakeChild();
      child.kill = vi.fn(() => true);
      children.push(child);
      return child;
    }) as unknown as SpawnFn;
    const runner = new NodeProcessRunner('sf', spawner, localResolver);

    await expect(runner.run(['stuck'], { timeoutMs: 5, closeGraceMs: 5 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });

    const next = runner.run(['next']);
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.emit('close', 0);
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });
});
