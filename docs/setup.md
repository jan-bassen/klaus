# Setup

This guide is the practical path from clone to a running Klaus container.

## Prerequisites

- Docker
- An Obsidian Sync account
- A WhatsApp account to link as a device
- `OPENROUTER_API_KEY`, unless you reconfigure the default provider to use another endpoint

Klaus runs as one Docker container. Inside it, the app supervises `obsidian-headless`, which keeps the configured vault directory synced with your remote Obsidian vault.
The image also includes `opus-tools` so TTS audio can be encoded to WhatsApp-compatible Ogg Opus voice notes.

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

Prefer `basics.allowedChat` in `{vault}/Klaus/settings.yml` over `ALLOWED_CHAT_ID`; the env var is a fallback for headless or test setups.

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
- `klaus-data`: WhatsApp credentials, Obsidian login state, conversation JSONL, file blobs, schedules, and timers.

Synology Container Manager and other compose-based installs can use host
folders instead:

```yaml
services:
  klaus:
    image: klaus:latest
    container_name: klaus
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
    volumes:
      - /path/to/klaus/vault:/vault
      - /path/to/klaus/data:/data
```

Keep `/vault` and `/data` as the internal container paths. Change the host-side paths before the colon.

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

## Operations

Day-two notes for keeping a deployment alive.

**Secrets.** Everything sensitive lives in `.env` (provider key, Obsidian credentials) and is passed to the container with `--env-file`. Nothing secret is baked into the image, so the image is safe to push to a private registry; the `.env` file is not. Keep it out of version control and off shared hosts. Rotating a key means editing `.env` and restarting the container.

**Publishing your own image.** The bundled image builds from the repo with no secrets inside, so you can host it yourself:

```bash
docker build -t <your-registry>/klaus:<tag> .
docker push <your-registry>/klaus:<tag>
```

Reference that name in your compose file instead of building on the host. Tag immutably (a version or commit SHA) rather than leaning on `latest`, so a redeploy is a deliberate version bump.

**Upgrading.** Pull or rebuild the new image, then recreate the container against the *same two volumes*:

```bash
docker pull <your-registry>/klaus:<tag>   # or: docker build -t klaus .
docker stop klaus && docker rm klaus
docker run -d ... klaus                    # same -v klaus-vault / klaus-data flags
```

State survives because it all lives in the volumes, not the container. After upgrading, watch `docker logs -f klaus` through first boot: a new or renamed setting fails startup loudly (see [settings](vault/settings.md)), so a clean boot is the signal the upgrade took.

**Backups.** Two volumes, two different recovery stories:

- `klaus-vault` is mirrored to Obsidian Sync, so the vault and your `Klaus/` config are already replicated remotely. A fresh deploy re-pulls it on first boot.
- `klaus-data` is **only** on the host: WhatsApp auth, Obsidian login state, conversation history, file blobs, schedules, and timers. Back this volume up if you care about conversation history or want to avoid relinking WhatsApp. Losing `baileys-auth` inside it forces a WhatsApp relink (see [infra](codebase/infra.md#whatsapp)).

---

Once Klaus is running, [usage](usage.md) covers talking to it, and [iteration](iteration.md) covers making it your own.
