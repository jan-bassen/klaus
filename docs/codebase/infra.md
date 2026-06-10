# Infra

`src/infra/` is everything that sits outside the turn loop: the Obsidian vault and its sync, WhatsApp, the flat-file stores, and the runtime plumbing they all share. This is the layer the [pipeline](pipeline.md) and [primitives](primitives.md) run on top of.

One piece of infra is documented as its own vault-authoring surface: [settings](../vault/settings.md) covers `settings.yml`, the settings groups, and how model routing resolves. This page covers the runtime, the vault, WhatsApp, and the stores.

```
infra/
  config.ts     # settings.yml + env paths + model resolution (the live `settings`)
  runtime.ts    # thin fs helpers (read/write/scan) used everywhere
  future.ts     # gate that starts/pauses schedules + timers
  logger.ts     # text/JSON logger
  store/        # history, files, schedules, timers
  vault/        # path resolution, defaults, sync, watcher, permissions, markdown
  whatsapp/     # Baileys connection, receive, send, presence, login
```

## Paths, env, and runtime

Paths resolve once at import. In `NODE_ENV=production` (Docker) they are `/vault` and `/data`; locally they are `./vault` and `./data`. Both are overridable with `KLAUS_VAULT_DIR` / `KLAUS_DATA_DIR`.

The other environment variables are: `OBSIDIAN_EMAIL` / `OBSIDIAN_PASSWORD` / `OBSIDIAN_VAULT_NAME` (required for sync), the optional `OBSIDIAN_MFA` / `OBSIDIAN_E2EE_PASSWORD`, the provider key (commonly `OPENROUTER_API_KEY`), and `LOG_FORMAT` / `STARTUP_CONNECTION_WARN_AFTER_MS` / `ALLOWED_CHAT_ID`. The operator's view of all of these is in [setup](../setup.md).

`runtime.ts` is a small wrapper over `node:fs/promises` (`readText`, `writeData`, `parseJsonObject`, `scanFiles`) that every store, the config loader, and the primitive loaders go through. `future.ts` is the gate that actually starts the schedule and timer clocks. It requires both a configured `allowedChat` and a live WhatsApp connection, and it is what `/stop` and `/resume` toggle.

SIGTERM and SIGINT use the graceful shutdown path: abort startup work, drain the WhatsApp send queue, stop Obsidian sync, close the socket, and stop local clocks. An uncaught exception is treated as process-corrupting; Klaus logs it and exits non-zero so the container supervisor can restart it cleanly.

## Vault

The vault is both the knowledge graph and the user-owned configuration. `{vault}/Klaus/` holds agents, skills, snippets, templates, reports, `settings.yml`, and `overrides.yml`.

**First-run defaults.** `ensureVaultDefaults` copies the bundled `vault/` template into `{vault}/Klaus/` **only if that folder does not exist**. Once it exists, it is user-owned: Klaus never backfills missing files or merges in new defaults. To fix a missing setting, copy the one field you want rather than the whole template.

**Obsidian sync.** Klaus supervises the bundled `obsidian-headless` (`ob`) CLI as a child process. At startup it logs in and links the vault, does a one-shot `mirror-remote` pull (remote wins) *before* writing anything, then runs continuous bidirectional sync with exponential-backoff restarts. Login state is pinned under `{dataDir}/obsidian-headless` so it survives restarts.

**Hot-reload.** A debounced file watcher reloads the relevant registry whenever a file changes: agent `.md` files re-register agents and re-sync their schedules, skill files re-register skills, `overrides.yml` reloads presets, and `settings.yml` reloads settings. If the new settings are invalid, Klaus keeps the last valid config and warns the chat instead of crashing. Template files invalidate their compiled partial.

### Permission model

Vault access is gated in two layers, both fail-closed:

1. **Global scopes** (`settings.vault.scopes`) are vault-relative paths that cannot escape the root. Anything outside every scope is unreachable by any agent. Paths are checked after resolving symlinks, so a link inside the vault cannot point tools at `{dataDir}` or another host path.
2. **Per-agent `vaultAccess`** is a `path → none|read|full` map, merged over the `agentDefaults` baseline. The longest matching prefix wins, `"*"` is the fallback, and no match means denied. Internally the `read`/`append`/`full` levels order the operations a tool may perform.

Every vault tool calls one choke point (`gateVaultTool`) that checks scope, then permission, and returns an absolute path or an error. How an agent declares its own slice of this is in [agents](../vault/agents.md#vault-access).

## WhatsApp

Klaus links to WhatsApp as a device via Baileys. Auth state lives under `{dataDir}/baileys-auth`, and losing it means relinking.

**Allowlist.** The gate is fail-closed and enforced in the [pipeline](pipeline.md), not in the transport. An unset `allowedChat` puts Klaus in setup mode with messages blocked, and only the configured chat is processed. The allowlist compares the chat JID; it does not restrict by sender JID inside a group, so group binding means shared group control. The transport layer just drops messages with no content and, outside self-mode, anything `fromMe`.

**Setup modes.** There are two ways to bind the chat:

- *Active chat*: a six-digit code is written into `_login/instructions.md`; sending it from the target chat binds that chat.
- *Self / solo mode*: Klaus runs on your own account, auto-binds its own JID on first connect, and prefixes its replies with a system label so you can tell them from your own text. You enable it by ticking the solo box in `instructions.md` or by setting `whatsapp.selfMode`.

**Login folder.** When no chat is configured, Klaus writes `{vault}/Klaus/_login/` with `instructions.md` and, once Baileys requests pairing, `qr-code.svg`. The setup code and QR are live WhatsApp linking credentials while they exist and the folder is inside the synced vault, so an E2EE Obsidian vault is strongly preferred. After binding, the folder is removed. If a chat is already configured but auth is missing, Klaus writes only a relink QR (no code needed) and clears it once connected. A hard logout has no auto-recovery: delete `baileys-auth` and restart.

WhatsApp transport is still WhatsApp transport, but Klaus is a linked device: it receives decrypted message content locally, can pass selected content to configured model providers and tools, and stores history, files, and reports under `{dataDir}` or `{vault}/Klaus/`.

**Sending.** Outbound messages go through a single FIFO queue with dedup, mime-aware routing (text, image, voice note, video, document), quote-reply support, and retry with backoff.

## Stores

All operational state lives under `{dataDir}`, separate from the vault. Each store is a module singleton initialised at startup, and its in-memory indexes are rebuilt by replaying the files.

| Store | Format | Location | Holds |
| --- | --- | --- | --- |
| `history` | JSONL, one file per day | `conversations/YYYY-MM-DD.jsonl` | Conversation events: `msg`, `ack`, `reaction`, `trace`, `break`. |
| `files` | JSONL index + blobs | `files/files-index.jsonl` + `files/<date>/<uuid>.<ext>` | Uploaded/generated file metadata and content. |
| `schedules` | single JSON array | `schedules.json` | Recurring cron jobs (croner). |
| `timers` | single JSON array | `timers.json` | One-shot future runs (`setTimeout`), including persistence reschedules. |

History is an append-only event log. `getConversation` reads the last `lookbackDays` files and truncates at the most recent `break`, applying acks (message-id → WhatsApp external id) and reactions onto their message rows. Assistant rows carry `agent`, `runId`, and a `voice`/`failed` flag. Reactions are stored against external ids and rendered as metadata, so a reaction-only turn stays visible without consuming a history slot.

The file index is JSONL for easy inspection, but it is compacted on metadata updates and deletes so message-id backfills and removed files do not accumulate stale duplicate records.

Schedules and timers are rewritten in full on each change and only *run* once the [future-work gate](#paths-env-and-runtime) opens (setup complete and WhatsApp connected). Timers farther out than Node's single-timeout limit are re-armed in bounded hops until their target instant arrives. Overdue timers catch up serially after downtime, so a restart does not burst several agent runs at once. They pause on disconnect and on `/stop`.

---

**Related:** [settings](../vault/settings.md) · [setup](../setup.md) · [pipeline](pipeline.md) · [primitives](primitives.md)
