# Infra

`src/infra/` wraps the outside world and durable runtime state. Pipeline code should treat these modules as boundaries: config, logging, vault access, sync, WhatsApp, stores, and simulation.

## Config

`src/infra/config.ts` loads repo defaults for local development and runtime settings from `{vault}/Klaus/settings.yml` after startup sync. The runtime settings file is strict:

- Zod validates only.
- There are no `.default()` fallbacks for missing runtime fields.
- New tunable settings must be added to both `vault/settings.yml` and the schema.
- Runtime does not merge repo defaults into an existing user vault.

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
short so long model/tool runs still show visible activity.

## Stores

Runtime state lives under `{dataDir}`:

| Store | Format | Purpose |
| --- | --- | --- |
| `history` | JSONL, day-partitioned | Conversation events, reactions, traces, context breaks. |
| `report` | JSONL, day-partitioned | Per-turn execution records. |
| `files` | JSONL index + blobs | Uploaded file metadata and stored content. |
| `schedules` | JSON + croner | Recurring cron jobs. |
| `timers` | JSON + setTimeout | One-shot future runs. |

Stores should stay simple and typed. Prefer flat files and explicit migrations only when a real format change requires them.

## Simulation

`src/infra/simulation.ts` holds the per-turn simulation overlay. Under `!simulate`, pure tools run normally while stateful and external tools route through their `simulate` handler or a generic fake result.

The overlay gives read-from-write coherence inside one simulated turn. A simulated `vault_write` followed by `vault_read` sees pending content; the same idea applies to dispatch timers, schedules, and file uploads.

## Logging

`src/infra/logger.ts` owns process logging. User-facing execution detail belongs in reports, not scattered logs. Logs should help diagnose startup and system-boundary failures.
