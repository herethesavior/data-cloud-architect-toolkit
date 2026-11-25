import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConnectorMode = 'live' | 'demo';

export interface ConnectorConfig {
  host: '127.0.0.1';
  port: number;
  mode: ConnectorMode;
  serveStatic: boolean;
  sessionToken: string;
  webDist: string;
  version: string;
  /** Bridge-local setting path. Hosted KV never stores API-version preferences. */
  compatibilityPath: string;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? '3847');
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 3847;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ConnectorConfig {
  const port = parsePort(env.DCAT_PORT);
  return {
    host: '127.0.0.1',
    port,
    mode: env.DCAT_DEMO === 'true' ? 'demo' : 'live',
    serveStatic: argv.includes('--serve-static'),
    sessionToken: randomBytes(32).toString('hex'),
    webDist: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    version: '0.1.0',
    compatibilityPath: env.DCAT_API_COMPATIBILITY_PATH || join(homedir(), '.dcat', 'api-compatibility.json'),
  };
}
