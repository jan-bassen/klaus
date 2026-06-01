# Infra

`src/infra/` is everything external to the turn loop: configuration, the Obsidian vault and its sync, WhatsApp, and the flat-file stores. This is the plumbing that the [pipeline](pipeline.md) and [primitives](primitives.md) run on top of.

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

## Settings

Runtime settings come from `{vault}/Klaus/settings.yml`, parsed once through a strict Zod schema (`config.ts`). The repo `vault/settings.yml` is only the first-run template — at runtime Klaus reads the user's synced copy and does not merge defaults into it. There are no Zod `.default()` fallbacks: a missing or misnamed field fails startup, so adding a setting in code means adding it to the schema and to the template.

Top-level groups:

| Group | Covers |
| --- | --- |
| `basics` | `locale`, `timezone`, `allowedChat`. |
| `agent` | Loop limits: `maxSteps`, `timeout`, `retries`, `maxChainDepth`, `lookbackDays`, `maxReasoningChars`. |
| `agentDefaults` | Per-agent defaults: model tier, voice, sampling presets, history, `showTools`, `report`, baseline `vaultAccess`. |
| `defaultProvider` / `providers` / `endpoints` | Model routing (below). |
| `sampling` | Temperature and top-p values behind the `cold`/`hot`/`creative`/`rigid` presets. |
| `media` | TTS, STT, vision max size, image generation, document OCR/limits. |
| `whatsapp` | `selfMode`, system label, send delay/retries, download limits, presence refresh. |
| `vault` | Watcher debounce, list caps, and `scopes` (the global path allowlist). |
| `persistence` | `minNextRun` / `maxNextRun` / `defaultNextRun` for reschedules. |
| `sync` | Obsidian sync shutdown timeout, file types, restart backoff, first-sync gate. |

The exported `settings` object is **live and mutable**: hot-reload and command-driven edits rebuild it in place via property descriptors, so existing imports keep working. `allowedChat` resolves from `basics.allowedChat`, then the `ALLOWED_CHAT_ID` env var.

### Model resolution

`resolveModel(provider, tier)` walks `providers[provider]` → its `endpoint` → `endpoints[...]` → the API key named by that endpoint's `apiKeyEnv`. It is fail-closed: an unknown provider, unknown endpoint, or missing key throws. The return is `{ baseURL, apiKey, modelId, tempScale }`, where `tempScale` is the provider's native temperature scale. At startup Klaus checks that the default provider's key env is present. Image generation resolves the same way via `resolveImageModel()`.

### Paths and env

Paths resolve once at import. In `NODE_ENV=production` (Docker) they are `/vault` and `/data`; locally they are `./vault` and `./data`; both are overridable with `KLAUS_VAULT_DIR` / `KLAUS_DATA_DIR`. Other env vars: `OBSIDIAN_EMAIL` / `OBSIDIAN_PASSWORD` / `OBSIDIAN_VAULT_NAME` (required for sync), optional `OBSIDIAN_MFA` / `OBSIDIAN_E2EE_PASSWORD`, the provider key (commonly `OPENROUTER_API_KEY`), and `LOG_FORMAT` / `STARTUP_CONNECTION_WARN_AFTER_MS` / `ALLOWED_CHAT_ID`. See [setup.md](setup.md) for the operator's view.

`runtime.ts` is a small wrapper over `node:fs/promises` (`readText`, `writeData`, `parseJsonObject`, `scanFiles`) that every store, the config loader, and the primitive loaders go through. `future.ts` is the gate that actually starts the schedule and timer clocks — it requires both `allowedChat` and a live WhatsApp connection, and is what `/stop` and `/resume` toggle.

## Vault

The vault is the knowledge graph and the user-owned config. `{vault}/Klaus/` holds agents, skills, snippets, templates, reports, `settings.yml`, and `overrides.yml`.

**First-run defaults.** `ensureVaultDefaults` copies the bundled `vault/` template into `{vault}/Klaus/` **only if that folder does not exist**. Once it exists it is user-owned: Klaus never backfills missing files or merges new defaults. Fix a missing setting by copying the one field you want, not the whole template.

**Obsidian sync.** Klaus supervises the bundled `obsidian-headless` (`ob`) CLI as a child process. At startup it logs in and links the vault, does a one-shot `mirror-remote` pull (remote wins) *before* writing anything, then runs continuous bidirectional sync with exponential-backoff restarts. Login state is pinned under `{dataDir}/obsidian-headless` so it survives restarts.

**Hot-reload.** A file watcher (debounced) reloads the relevant registry on change: agent `.md` files re-register agents and re-sync their schedules; skill files re-register skills; `overrides.yml` reloads presets; `settings.yml` reloads settings — and if the new settings are invalid, Klaus keeps the last valid config and warns the chat instead of crashing; template files invalidate their compiled partial.

### Permission model

Vault access is gated in two layers, both fail-closed:

1. **Global scopes** (`settings.vault.scopes`) — vault-relative paths that cannot escape the root. Anything outside every scope is unreachable by any agent.
2. **Per-agent `vaultAccess`** — a `path → none|read|full` map (merged over the `agentDefaults` baseline). The longest matching prefix wins, `"*"` is the fallback, and no match means denied. Internally `read`/`append`/`full` levels order the operations a tool may perform.

Every vault tool calls one choke point (`gateVaultTool`) that checks scope then permission and returns an absolute path or an error. See [agents.md](agents.md#vault-access) for how agents declare this.

## WhatsApp

Klaus links to WhatsApp as a device via Baileys. Auth state lives under `{dataDir}/baileys-auth`; losing it means relinking.

**Allowlist.** The gate is fail-closed and enforced in the [pipeline](pipeline.md), not the transport: an unset `allowedChat` puts Klaus in setup mode (messages blocked); only the configured chat is processed. The transport layer just drops messages with no content and, outside self-mode, anything `fromMe`.

**Setup modes.** Two ways to bind the chat:
- *Active chat*: a six-digit code is written into `_login/instructions.md`; sending it from the target chat binds that chat.
- *Self / solo mode*: Klaus runs on your own account, auto-binds its own JID on first connect, and prefixes its replies with a system label so you can tell them from your own text. Enabled by ticking the solo box in `instructions.md` or setting `whatsapp.selfMode`.

**Login folder.** When no chat is configured, Klaus writes `{vault}/Klaus/_login/` with `instructions.md` and, once Baileys requests pairing, `qr-code.svg`. After binding, the folder is removed. If a chat is already configured but auth is missing, Klaus writes only a relink QR (no code needed) and clears it once connected. A hard logout has no auto-recovery — delete `baileys-auth` and restart.

**Sending.** Outbound messages go through a single FIFO queue with dedup, mime-aware routing (text, image, voice note, video, document), quote-reply support, and retry with backoff.

## Stores

All operational state is under `{dataDir}`, separate from the vault. Each store is a module singleton initialised at startup; in-memory indexes are rebuilt by replaying the files.

| Store | Format | Location | Holds |
| --- | --- | --- | --- |
| `history` | JSONL, one file per day | `conversations/YYYY-MM-DD.jsonl` | Conversation events: `msg`, `ack`, `reaction`, `trace`, `break`. |
| `files` | JSONL index + blobs | `files/files-index.jsonl` + `files/<date>/<uuid>.<ext>` | Uploaded/generated file metadata and content. |
| `schedules` | single JSON array | `schedules.json` | Recurring cron jobs (croner). |
| `timers` | single JSON array | `timers.json` | One-shot future runs (`setTimeout`), incl. persistence reschedules. |

History is an append-only event log. `getConversation` reads the last `lookbackDays` files and truncates at the most recent `break`, applying acks (message-id → WhatsApp external id) and reactions onto their message rows. Assistant rows carry `agent`, `runId`, and a `voice`/`failed` flag; reactions are stored against external ids and rendered as metadata, so a reaction-only turn stays visible without consuming a history slot.

Schedules and timers are rewritten in full on each change and only *run* once the [future-work gate](#settings) opens (setup complete and WhatsApp connected). They pause on disconnect and on `/stop`.
