# Setup Guide

This guide is the practical path from clone to a running Klaus container. The short version lives in the README; this page fills in the fiddly parts.

## Prerequisites

- Docker
- Node 25 and npm
- An Obsidian Sync account
- A WhatsApp account to link as a device
- `OPENROUTER_API_KEY`, unless you change every configured provider away from the default OpenRouter endpoint
- Optional `ELEVENLABS_API_KEY` for speech-to-text and text-to-speech

Klaus runs as one Docker container. Inside it, the app supervises `obsidian-headless`, which keeps `/app/vault` synced with your remote Obsidian vault.

## Environment

Copy the example file:

```bash
cp .env.example .env
```

Required:

```dotenv
OPENROUTER_API_KEY=
OBSIDIAN_EMAIL=
OBSIDIAN_PASSWORD=
OBSIDIAN_VAULT_NAME=
```

Optional:

```dotenv
ELEVENLABS_API_KEY=
OBSIDIAN_MFA=
OBSIDIAN_E2EE_PASSWORD=
LOG_FORMAT=text
STARTUP_CONNECTION_WARN_AFTER_MS=60000
ALLOWED_CHAT_ID=
```

Prefer `basics.allowedChat` in `{vault}/Klaus/settings.yml` over `ALLOWED_CHAT_ID`; the env var is mainly a fallback for headless or test setups.

## Build And Run

Build the local image:

```bash
npm run build
```

Run it with separate vault and data volumes:

```bash
docker run -d --restart unless-stopped \
  --name klaus \
  --env-file .env \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  -p 3000:3000 \
  klaus
```

The two volumes have different jobs:

- `klaus-vault`: Synced obsidian vault.
- `klaus-data`: WhatsApp credentials, Obsidian login state, conversation JSONL, file blobs, schedules, timers, report JSONL.

Watch logs with:

```bash
docker logs -f klaus
```

## First Boot

Startup does this in order:

1. Logs in to Obsidian Sync using `.env`.
2. Links `/app/vault` to `OBSIDIAN_VAULT_NAME`.
3. Mirrors the remote vault before Klaus writes startup defaults.
4. Copies the bundled `vault/` template into `/app/vault/Klaus`, *but only if that folder does not already exist*.
5. Loads `/app/vault/Klaus/settings.yml`.
6. Starts continuous bidirectional Obsidian Sync.
7. Loads tools, agents, variables, commands, skills, templates, overrides, stores, schedules, timers, and WhatsApp.

## WhatsApp Login

Klaus writes the login QR to:

```text
{vault}/Klaus/_login/qr-code.svg
```

Open it from Obsidian or the mounted vault, then scan it from WhatsApp -> Linked Devices.

After the device links, send any message to the paired number. If no chat is allowlisted, Klaus replies in setup mode with your chat ID. Add it to:

```yaml
basics:
  allowedChat: "<your-chat-id>"
```

Settings hot-reload, so the next message should run normally.

## Self-Mode

Set this in `{vault}/Klaus/settings.yml`:

```yaml
whatsapp:
  selfMode: true
```

In self-mode, Klaus runs on your own WhatsApp account. You message the "Note to Self" chat, and Klaus replies there. Agent replies are labelled so you can tell system messages apart from your own text.

## E2EE Vaults

If your Obsidian vault is end-to-end encrypted, set:

```dotenv
OBSIDIAN_E2EE_PASSWORD=
```

The password is passed to `obsidian-headless` during first-time sync setup.

## Common Issues

**Missing Obsidian env vars**

Startup fails closed when `OBSIDIAN_EMAIL`, `OBSIDIAN_PASSWORD`, or `OBSIDIAN_VAULT_NAME` is missing. Fill `.env`, then recreate or restart the container.

**Missing model API key**

The default provider points at the `openrouter` endpoint, so `OPENROUTER_API_KEY` must be set unless `settings.yml` routes the default provider to another endpoint.

**Invalid settings after sync**

Runtime settings are read from `{vault}/Klaus/settings.yml` and validated strictly with Zod. The repo `vault/settings.yml` is only a first-run template. If logs say settings were downloaded but invalid or missing, debug the synced file, path, YAML syntax, and schema shape. Do not fix this by merging bundled defaults into an existing user-owned `Klaus/` folder.

**MFA does not work on first boot**

If Obsidian Sync refuses a one-time `OBSIDIAN_MFA` value in the container flow, seed login state interactively once:

```bash
docker run --rm -it \
  --env-file .env \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  klaus \
  env HOME=/app/data/obsidian-headless \
    XDG_CACHE_HOME=/app/data/obsidian-headless/cache \
    XDG_CONFIG_HOME=/app/data/obsidian-headless/config \
    XDG_DATA_HOME=/app/data/obsidian-headless/data \
    ob login
```

Then start the normal container again.

**Vault looks stale on startup**

Klaus performs an initial mirror-remote sync before loading settings and agents, then waits for the first continuous sync to settle. If your vault still looks stale, check Obsidian Sync logs, the remote vault name, and whether `sync.firstSync.timeoutMs` is too low for the first hydration.

**WhatsApp QR keeps rotating**

Check that `klaus-data` is mounted and persistent. WhatsApp auth lives under `/app/data/baileys-auth`; losing that data means relinking.

**Clean reset**

This deletes runtime state:

```bash
docker rm -f klaus
docker volume rm klaus-vault klaus-data
```

Use it only when you are comfortable relinking Obsidian Sync and WhatsApp from scratch.
