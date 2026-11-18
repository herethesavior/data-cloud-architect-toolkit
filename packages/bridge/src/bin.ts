import { safeErrorMessage } from '@dcat/salesforce-cli';
import { main } from './main.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

await main(process.argv.slice(2), controller.signal).catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
