import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'apps/web/dist/_worker.js');

await build({
  entryPoints: [resolve(root, 'apps/hosted-worker/src/pages.ts')],
  outfile,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  mainFields: ['module', 'main'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

// Keep server code out of the public asset manifest for the standalone Worker
// deployment. Pages still consumes _worker.js as the advanced-mode function.
await writeFile(resolve(root, 'apps/web/dist/.assetsignore'), '_worker.js\n');
