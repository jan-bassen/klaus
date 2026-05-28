# Setup

This guide is the practical path from clone to a running Klaus container. The short version lives in the README; this page fills in the fiddly parts.

## Prerequisites

- Docker
- An Obsidian Sync account
- A WhatsApp account to link as a device
- `OPENROUTER_API_KEY`, unless you reconfigure the default provider to use another endpoint

Klaus runs as one Docker container. Inside it, the app supervises `obsidian-headless`, which keeps the configured vault directory synced with your remote Obsidian vault.
The image also includes `opus-tools` so Gemini PCM TTS can be encoded to WhatsApp-compatible Ogg Opus voice notes.

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

`OPENROUTER_API_KEY` is required for the bundled settings because the default provider routes through OpenRouter. If you edit `{vault}/Klaus/settings.yml` to point the default provider at another OpenAI-compatible endpoint, set that endpoint's `apiKeyEnv` instead.

Optional:

```dotenv
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
docker build -t klaus .
```

Run it with separate vault and data volumes:

```bash
docker run -d --restart unless-stopped \
  --name klaus \
  --env-file .env \
  -v klaus-vault:/vault \
  -v klaus-data:/data \
  klaus
```

The two volumes have different jobs:

- `klaus-vault`: Synced Obsidian vault.
- `klaus-data`: WhatsApp credentials, Obsidian login state, conversation JSONL, file blobs, schedules, timers, and per-run report JSON.

Synology Container Manager and other compose-based installs can use host
folders instead:

```yaml
services:
  klaus:
    image: janbassen1/klaus:latest
    container_name: klaus
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
    volumes:
      - /volume1/docker/klaus/vault:/vault
      - /volume1/docker/klaus/data:/data
```

Keep `/vault` and `/data` as the container paths. Change only the host-side paths before the colon.

Watch logs with:

```bash
docker logs -f klaus
```

## First Boot

Startup does this in order:

1. Logs in to Obsidian Sync using `.env`.
2. Links `{vault}` to `OBSIDIAN_VAULT_NAME`.
3. Mirrors the remote vault before Klaus writes startup defaults.
4. Copies the bundled `vault/` template into `{vault}/Klaus`, *but only if that folder does not already exist*.
5. Loads `{vault}/Klaus/settings.yml`.
6. Creates data directories and starts continuous bidirectional Obsidian Sync.
7. Loads stores, tools, agents, variables, commands, skills, templates, overrides, schedules, and timers.
8. Creates the WhatsApp setup folder if no allowed chat is configured.
9. Connects WhatsApp and writes the QR code when Baileys provides one. If an allowed chat is already configured, the folder is only a relink helper and is removed once WhatsApp connects.
10. Starts schedule and timer clocks once the allowed chat is configured and WhatsApp is connected.

## WhatsApp Login

Klaus writes a temporary login folder to:

```text
{vault}/Klaus/_login/
```

Open `instructions.md` first. It contains the current active-chat setup code and a solo-mode checkbox.

The QR itself is written to:

```text
{vault}/Klaus/_login/qr-code.svg
```

Scan it from WhatsApp -> Linked Devices after choosing the setup mode:

- **Solo mode**: Tick the solo checkbox before scanning. Klaus runs on the WhatsApp account you are linking, auto-resolves its own chat, writes `basics.allowedChat` and `whatsapp.selfMode`, sends the welcome message, and removes `_login`.
- **Active chat mode**: Leave the checkbox unticked, scan the QR, then send the six-digit setup code from the chat Klaus should listen to. Klaus writes `basics.allowedChat`, sends the welcome message, and removes `_login`.
- **Relink mode**: If `basics.allowedChat` or `ALLOWED_CHAT_ID` is already set but `{dataDir}/baileys-auth` is missing, Klaus still writes `_login/qr-code.svg` so you can link WhatsApp again. No setup code is needed; `_login` is removed after WhatsApp connects.

You can still pin `basics.allowedChat` manually in `{vault}/Klaus/settings.yml` or with `ALLOWED_CHAT_ID`, but the normal clone-and-deploy path should not need it.

## Self-Mode

To skip the checkbox, set this before first WhatsApp login in `{vault}/Klaus/settings.yml`:

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

**Container exits immediately**

Run `docker logs klaus` and look for the first `[startup]` error. The most common hard failures are missing Obsidian env vars, a failed Obsidian login, or a missing API key for the configured default provider.

For the bundled settings, these must be present:

```dotenv
OPENROUTER_API_KEY=
OBSIDIAN_EMAIL=
OBSIDIAN_PASSWORD=
OBSIDIAN_VAULT_NAME=
```

If you changed `defaultProvider` or an endpoint in `{vault}/Klaus/settings.yml`, the required API key may not be `OPENROUTER_API_KEY`; it is whatever that endpoint's `apiKeyEnv` names.

**Obsidian login or vault link fails**

Check that `OBSIDIAN_EMAIL`, `OBSIDIAN_PASSWORD`, and `OBSIDIAN_VAULT_NAME` match the Obsidian Sync account and remote vault exactly. Klaus stores Obsidian login state under `{dataDir}/obsidian-headless`, so the data volume must be mounted and persistent.

If you need to retry first-time Obsidian setup from a clean state, stop the container and remove only the data volume. This also removes WhatsApp auth, schedules, timers, history, files, and reports:

```bash
docker rm -f klaus
docker volume rm klaus-data
```

Then start the normal `docker run` command again.

**MFA does not work on first boot**

`OBSIDIAN_MFA` is a one-time code. If Obsidian Sync refuses it in the container flow, seed login state interactively once:

```bash
docker run --rm -it \
  --env-file .env \
  -v klaus-vault:/vault \
  -v klaus-data:/data \
  klaus \
  env HOME=/data/obsidian-headless \
    XDG_CACHE_HOME=/data/obsidian-headless/cache \
    XDG_CONFIG_HOME=/data/obsidian-headless/config \
    XDG_DATA_HOME=/data/obsidian-headless/data \
    ob login
```

Then start the normal container again.

**E2EE vault does not sync**

Set `OBSIDIAN_E2EE_PASSWORD` in `.env`. Klaus passes it to `ob sync-setup` only during first-time vault linking. If you linked the vault once without the E2EE password, reset the Obsidian login/link state by removing `klaus-data`, then start again with the password set.

**Invalid settings after sync**

Runtime settings are read from `{vault}/Klaus/settings.yml` and validated strictly with Zod. The repo `vault/settings.yml` is only a first-run template. Once `{vault}/Klaus/` exists, that folder is user-owned state: Klaus does not merge new defaults into it or backfill missing fields.

If startup fails because `settings.yml` is missing or invalid, inspect the synced file itself:

- YAML syntax must be valid.
- Top-level sections and fields must match the schema in `src/infra/config.ts`.
- New settings added in code must also be added to the user's `{vault}/Klaus/settings.yml`.
- There are no Zod `.default()` fallbacks for missing fields.

Do not fix this by merging the bundled `vault/` folder into an existing vault. Copy over only the specific missing setting you intentionally want.

**Vault looks stale on startup**

Klaus performs an initial `mirror-remote` sync before loading settings and agents, then starts continuous bidirectional sync and waits for it to go quiet. If your vault still looks stale, check the Obsidian Sync logs, the remote vault name, and whether `sync.firstSync.timeoutMs` is too low for the first hydration.

Also check `sync.fileTypes` in `{vault}/Klaus/settings.yml`. It should include `unsupported`, otherwise Obsidian Sync may skip Klaus YAML files such as `settings.yml` and `overrides.yml`.

**No `{vault}/Klaus/_login/` folder appears**

Klaus creates `_login` immediately only when no allowed chat is configured. If `basics.allowedChat` is already set in `{vault}/Klaus/settings.yml` or `ALLOWED_CHAT_ID` is set in `.env`, setup mode is skipped and `_login` appears only if WhatsApp needs a fresh QR.

If neither is set, check logs for earlier startup errors. WhatsApp setup happens after Obsidian sync, settings validation, provider API-key validation, store initialization, and primitive loading.

**QR code is missing**

Open `{vault}/Klaus/_login/instructions.md` first; it is created before the QR. The QR appears at `{vault}/Klaus/_login/qr-code.svg` only after the WhatsApp connection asks for pairing. Watch logs with:

```bash
docker logs -f klaus
```

If `basics.allowedChat` or `ALLOWED_CHAT_ID` is already configured, setup mode is skipped; just scan the QR in `_login` to link WhatsApp.

If you see `WhatsApp pairing/connection is taking longer than expected`, keep the container running a little longer unless another error appears.

**WhatsApp QR keeps rotating**

Check that the data volume is mounted and persistent. WhatsApp auth lives under `{dataDir}/baileys-auth`; losing that data means relinking.

**Setup code is ignored**

The six-digit code must be sent from the chat Klaus should listen to, and only after the QR has been scanned. In active chat mode, Klaus ignores normal messages until the code matches.

If you changed `instructions.md`, make sure you did not delete or alter the current code. Restarting can generate a new code.

**Solo checkbox was ticked but setup did not finish**

The checkbox must be ticked before scanning, or while the container is running and watching `instructions.md`. Klaus can only auto-resolve its own chat after WhatsApp has connected and Baileys exposes the bot JID.

If setup does not complete, leave the container running and check logs for `solo tick detected but bot JID unavailable yet`. It should retry when the socket opens. You can also set `whatsapp.selfMode: true` in `{vault}/Klaus/settings.yml` before first WhatsApp login.

**Klaus receives messages but does not reply**

Check the allowlist first. Klaus is fail-closed: it processes only the chat in `basics.allowedChat` or `ALLOWED_CHAT_ID`. If you used active chat mode, confirm the setup code was sent from the exact chat you want Klaus to answer.

Also check that the default provider's API key is still available and that the configured model IDs are valid for that endpoint.

**Clean reset**

This deletes runtime state:

```bash
docker rm -f klaus
docker volume rm klaus-vault klaus-data
```

Use it only when you are comfortable relinking Obsidian Sync and WhatsApp from scratch.
