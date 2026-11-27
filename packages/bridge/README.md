# @dcat-toolkit/bridge

The local outbound agent for [DCAT (Data Cloud Architect Toolkit)](https://github.com/herethesavior/data-cloud-architect-toolkit). It lets the hosted workbench read Data 360 metadata through Salesforce CLI on **your** machine. The bridge opens no inbound port, needs no tunnel, and never asks for a password, token, auth URL, or client secret.

## Requirements

- Node.js 22.12 or newer.
- Salesforce CLI. `setup` installs `@salesforce/cli` globally if it is missing; set `DCAT_SKIP_CLI_INSTALL=1` to skip that step.
- A one-time pairing code from **Org Connections → Step 1** on the DCAT site you want to use.

## Install and pair

```bash
npx -y @dcat-toolkit/bridge@latest setup --relay https://<site-url> --code <pairing-code>
```

`setup` checks Salesforce CLI, pairs this browser session, saves the pairing locally, and starts the agent in the foreground. Leave the terminal open while DCAT is in use. The pairing code is short-lived; create a new one in the site if it has expired.

## Restart later

```bash
npx -y @dcat-toolkit/bridge@latest start
```

`start` reuses the saved pairing. Stop the agent with `Ctrl+C` (or `SIGTERM`); it finishes the current step and exits cleanly.

The bridge stores only the relay origin, agent token, and its own version in `~/.dcat/bridge.json` with mode `600`. It never reads the Salesforce CLI credential store. Only ten typed, read-only operations are accepted: `cli.status`, `org.list`, `org.connect`, `inventory.get`, `inventory.start`, `inventory.status`, `transform.get`, `mode.set`, `compatibility.set`, and `bridge.update`. There is no shell, URL proxy, arbitrary command, or SOQL. Process output is redacted before it is returned to the browser.

## Logging

Every log line has an ISO timestamp. Normal output is intentionally bounded so the bridge can run for days without filling a terminal or log file:

- Startup and pairing: the installed bridge and Salesforce CLI versions.
- One line when each request starts and one when it finishes, with its operation, short request id, and duration.
- Progress polls (`inventory.status`) are omitted from normal output; they run about once per second during a load.
- Relay failures are logged once, then summarized at most every five minutes while they keep repeating. Recovery is announced once.
- Cancelled requests, terminal results, pairing loss, and updates are always reported.

```bash
npx -y @dcat-toolkit/bridge@latest start --verbose   # include polls and progress detail
npx -y @dcat-toolkit/bridge@latest start --quiet    # failures only
```

`DCAT_BRIDGE_LOG_LEVEL=debug` and `DCAT_BRIDGE_LOG_LEVEL=quiet` do the same for long-running service installs. `--quiet` wins over `--verbose` when both are present. Logs never contain the agent token or credential-shaped values.

`dcat-bridge --help` prints the same options.

## Reliability

- The agent long-polls one outbound HTTPS endpoint; idle polls are held open by the site and only failures use a short backoff.
- Each relay call has a deadline (45 seconds for a long poll), so a stalled socket cannot silently freeze the bridge.
- Completed results are retried a few times if the response POST is dropped. An oversized result is reported to the site as a terminal result for that request; the bridge keeps serving new requests.
- Salesforce CLI commands are serialized and bounded by the CLI wrapper. Installer and update commands now have deadlines too, and their captured output is capped.
- A revoked pairing stops the agent with an actionable message. A fresh code from the site is required to pair again.

## Updates

When a newer release exists, **Org Connections** shows a copyable command to run on the bridge machine:

```bash
npm install -g @dcat-toolkit/bridge@latest
```

Restart the agent afterwards. Bridges at version 0.1.4 or newer also accept an update requested by the paired site: the agent installs `@latest` and hands off to a detached replacement. If the site does not reconnect after an update, run `start` manually.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `No saved bridge pairing` | Run `setup` with a fresh code from Org Connections. |
| `Salesforce CLI is required` | Install `@salesforce/cli` globally, or remove `DCAT_SKIP_CLI_INSTALL=1` and run `setup` again. |
| `The site reset this bridge pairing` | Pair again; an agent token cannot be revived. |
| `The relay did not respond in time` | Check the bridge machine's network and that the site is reachable; the agent will retry. |
| Site shows the bridge as offline | Check the terminal for errors and restart with `start`. |
| A version is reported as outdated | Run the update command above, then restart the bridge. |

## Published package

`@dcat-toolkit/bridge` is published to npm from `packages/bridge` by the repository's `bridge-vX.Y.Z` tag workflow. Validating a release runs the type check, unit tests, bridge build, and then stages the package for maintainer approval with 2FA. The hosted site always installs `@latest`; use `npm view @dcat-toolkit/bridge version` to see the published version.

See the repository [README](https://github.com/herethesavior/data-cloud-architect-toolkit#readme) for the full security model and hosted setup guide.
