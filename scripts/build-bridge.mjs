import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'packages/bridge/dist/bridge.mjs');

await build({
  entryPoints: [resolve(root, 'packages/bridge/src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: resolve(root, 'tsconfig.json'),
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

await chmod(outfile, 0o755);
