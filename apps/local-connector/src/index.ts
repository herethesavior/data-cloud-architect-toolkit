import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`DCAT connector listening on http://${config.host}:${config.port} (${config.mode} mode)`);
    console.log('Salesforce CLI is invoked only through fixed, read-only allowlisted commands.');

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, async () => {
        await app.close();
        process.exit(0);
      });
    }
  } catch (error) {
    console.error('Could not start the DCAT connector.', error);
    process.exitCode = 1;
  }
}

await main();
