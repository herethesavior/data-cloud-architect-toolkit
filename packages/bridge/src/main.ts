import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, safeErrorMessage } from '@dcat/salesforce-cli';
import { runBridge } from '../../../apps/local-connector/src/bridge.ts';
import { resolveBridgeLogLevel } from '../../../apps/local-connector/src/bridge-logging.ts';
import { loadConfig } from '../../../apps/local-connector/src/config.ts';
import { createAppState } from '../../../apps/local-connector/src/state.ts';
import { normalizeRelayUrl, parseStoredBridge, validatePairingCode, type StoredBridge } from './config.ts';
import { ensureSalesforceCli } from './install.ts';
import { updateBridge } from './update.ts';
import { BRIDGE_VERSION } from './version.ts';

const HELP = `DCAT Bridge

  npx -y @dcat-toolkit/bridge@latest setup --relay <site-url> --code <pairing-code>
  npx -y @dcat-toolkit/bridge@latest start

setup installs Salesforce CLI when needed, pairs this browser session, and starts the bridge.
start reconnects with the saved pairing. DCAT never asks for Salesforce credentials.
An update requested by the paired site installs the latest release and restarts the bridge automatically.

Options:
  --verbose       Log relay polls and progress checks (same as DCAT_BRIDGE_LOG_LEVEL=debug).
  --quiet         Log failures only (same as DCAT_BRIDGE_LOG_LEVEL=quiet).

Every log line has a timestamp. Normal output stays bounded during long runs;
repeated relay failures are summarized instead of printed on every retry.`;

const configPath = join(homedir(), '.dcat', 'bridge.json');

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readStored(): Promise<StoredBridge> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'No saved bridge pairing. Run setup with the code shown in the site.');
  }
  try {
    return parseStoredBridge(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new CliError('INVALID_ARGUMENT', safeErrorMessage(error));
  }
}

async function saveStored(value: StoredBridge): Promise<void> {
  await mkdir(join(homedir(), '.dcat'), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFile's mode only applies to new files; tighten an existing file too.
  await chmod(configPath, 0o600).catch(() => {});
}

export async function main(argv: readonly string[] = process.argv.slice(2), signal?: AbortSignal): Promise<void> {
  const command = argv[0] ?? 'start';
  const logger = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
  const logLevel = resolveBridgeLogLevel(argv, process.env);

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }

  const config = { ...loadConfig(process.env, argv), mode: 'live' as const, version: BRIDGE_VERSION };
  const logArgs = argv.filter((arg) => arg === '--verbose' || arg === '--quiet');
  const onUpdate = () => updateBridge({ logger, env: process.env, logArgs });
  const state = createAppState(config);

  if (command === 'setup') {
    const relay = argValue(argv, '--relay') ?? process.env.DCAT_RELAY_URL;
    const code = argValue(argv, '--code') ?? process.env.DCAT_PAIRING_CODE;
    if (!relay || !code) {
      throw new CliError('INVALID_ARGUMENT', 'Usage: @dcat-toolkit/bridge setup --relay <site-url> --code <pairing-code>');
    }
    const relayUrl = normalizeRelayUrl(relay);
    const pairingCode = validatePairingCode(code);
    state.cliStatus = await ensureSalesforceCli({ logger });
    logger('Pairing this browser session with DCAT…');
    await runBridge({
      relayUrl,
      code: pairingCode,
      state,
      signal,
      logger,
      logLevel,
      onPaired: (token) => saveStored({ relayUrl, token, version: config.version }),
      onUpdate,
    });
    return;
  }

  if (command !== 'start') {
    throw new CliError('INVALID_ARGUMENT', `Unknown command "${command}". Run @dcat-toolkit/bridge --help.`);
  }

  const stored = await readStored();
  state.cliStatus = await ensureSalesforceCli({ logger });
  logger(`Reconnecting to ${stored.relayUrl}…`);
  await runBridge({
    relayUrl: stored.relayUrl,
    token: stored.token,
    state,
    signal,
    logger,
    logLevel,
    onUpdate,
  });
}
