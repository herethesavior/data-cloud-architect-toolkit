# @dcat-toolkit/bridge

One-command local installer and outbound agent for the hosted DCAT workbench.

```bash
npx -y @dcat-toolkit/bridge@latest setup --relay https://<site> --code <pairing-code>
```

`setup`:

1. Detects Salesforce CLI and installs `@salesforce/cli` globally when it is missing.
2. Pairs this browser session with the site using the one-time code.
3. Starts the bridge immediately in the foreground.

```bash
npx -y @dcat-toolkit/bridge@latest start
```

`start` reconnects with the saved pairing. The bridge stores only the relay origin, agent token, and version in `~/.dcat/bridge.json` with mode `600`. It never stores Salesforce usernames, passwords, tokens, or auth URLs, and it accepts only typed allowlisted operations from the site.
