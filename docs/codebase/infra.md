# Infra

`src/infra/` wraps the outside world and durable runtime state. Pipeline code should treat these modules as boundaries: config, logging, vault access, sync, WhatsApp, and stores.

## Config

`src/infra/config.ts` loads repo defaults for local development and runtime settings from `{vault}/Klaus/settings.yml` after startup sync. The runtime settings file is strict:

- Zod validates only.
- There are no `.default()` fallbacks for missing runtime fields.
- New tunable settings must be added to both `vault/settings.yml` and the schema.
- Runtime does not merge repo defaults into an existing user vault.
- Startup fails if the synced runtime `settings.yml` exists but is invalid. Hot reload keeps the last valid config and warns the user.

The exported `settings` object is live and mutable, which tests use for targeted overrides.

## Vault

`src/infra/vault/` handles path resolution, permission checks, Markdown helpers, the file watcher, bundled defaults, and Obsidian Sync.

The first-run rule is important: `ensureDefaults()` checks only whether `{vault}/Klaus/` exists. If it does not, Klaus copies the repo `vault/` tree once. If it does, that folder is user-owned and must not be merged or overwritten.

Vault permissions are layered from settings defaults, agent frontmatter, and per-turn overrides. The tool implementations live in `src/infra/vault/tools.ts` and are exposed through the `vault` toolset.

## WhatsApp

`src/infra/whatsapp/` wraps Baileys:

| File | Role |
| --- | --- |
| `connection.ts` | Socket lifecycle and connection state. |
| `login.ts` | First-run QR, setup code, self-mode, allowed chat setup. |
| `receive.ts` | Inbound message normalization. |
| `send.ts` | Outbound queue, labels, retries, media sends. |
| `presence.ts` | Typing/recording indicators, refreshed during long turns. |

Klaus is fail-closed. It processes only the configured allowed chat unless it is still in setup mode.

`settings.whatsapp.presenceRefreshMs` controls how often Klaus re-sends
`composing`/`recording` while an inbound WhatsApp turn is running. Keep it
comfortably below the client expiry window; the bundled default is deliberately
short so long model/tool runs still show visible activity. Once a top-level
Once `send_message` has queued visible output, Klaus stops the active presence keeper so
post-message persistence and reporting do not reopen the typing/recording bubble.
Queued refresh callbacks also no-op after the keeper is stopped.

Baileys can close the stream with `restartRequired` (`515`) immediately after
QR login or credential sync. Klaus treats that as a normal socket restart:
it reconnects with the same auth state at info level and suppresses Baileys'
raw stream-error log for that expected case.

## Stores

Runtime state lives under `{dataDir}`. Local runs default to `./data`; production/Docker runs default to `/data`. The vault root follows the same pattern: `./vault` locally and `/vault` in production/Docker. `KLAUS_DATA_DIR` and `KLAUS_VAULT_DIR` can override those defaults, but normal Docker deployments should keep the container paths fixed and change only the host-side volume paths.

| Store | Format | Purpose |
| --- | --- | --- |
| `history` | JSONL, day-partitioned | Conversation events, reactions, traces, context breaks. |
| `report` | JSONL, day-partitioned | Per-turn execution records. |
| `files` | JSONL index + blobs | Uploaded file metadata and stored content. |
| `schedules` | JSON + croner | Recurring cron jobs. |
| `timers` | JSON + setTimeout | One-shot future runs. |

Stores should stay simple and typed. Prefer flat files and explicit migrations only when a real format change requires them.

History assistant rows carry their agent, run ID, and a `voice` marker when the message was successfully sent as TTS audio. History reaction events target WhatsApp external IDs. Bot reactions include the agent and run ID when Klaus produced them, so history replay can show reaction-only agent turns and agent-scoped history can treat them as handled messages.

Schedules and timers persist only the future work to run. They do not carry chat IDs; scheduled agent runs resolve the single configured chat from `settings.allowedChat` at fire time.

The stores can be loaded while paused. `src/infra/future.ts` activates both clocks only when setup has produced `settings.allowedChat` and the WhatsApp socket is connected, and the connection close handler pauses them again during reconnects. The wait-state log is deduplicated so repeated reconnect checks do not spam the same setup/connection message.

## Logging

`src/infra/logger.ts` owns process logging. User-facing execution detail belongs in reports, not scattered logs. Logs should help diagnose startup and system-boundary failures. Template watcher logs use "refreshed" for normal cache invalidation so routine reloads do not read like errors.

The Obsidian Sync supervisor forwards meaningful `ob` output, but suppresses the
routine stdout `fully synced` status because continuous sync emits it after
normal vault edits.
