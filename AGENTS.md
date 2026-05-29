# AGENTS.md

Guidance for Codex when working in this repository.

## Status
- We are in developent, nothing is deployed yet. If we change something, clean up after - no legacy code!
- Always keep documentation (docs/, README.md, and AGENTS.md) up-to-date with all changes.
- Docs mirror the architecture, not audience categories: `docs/setup.md`, `docs/architecture.md`, `docs/codebase/`, and `docs/vault/`.

## Code conventions

- Goal: Short, clean and readable code. Try to remove, not add.
- No barrel imports. Use specific relative module paths with explicit `.ts` extensions.
- Errors are values — `return` them; only throw at true system boundaries.
- Fully typesafe. No `any`. No `as`.
- `vault/settings.yml` (repo) is the first-run template for tunable settings. At runtime Klaus reads the user's `{vault}/Klaus/settings.yml` directly; it is not merged with repo defaults. Zod validates only — no `.default()` fallbacks. Add new fields here + in `src/infra/config.ts`'s schema.
- No inline magic numbers — route through `settings.*`.
- Prefer direct edits to the owned surface over adding configuration. For example, tune bundled templates in `vault/templates/` with existing helpers before adding settings/schema fields. This codebase is intentionally minimal; do not add new knobs, abstractions, or migration burden unless the behavior truly needs to be runtime-configurable.
- Comments explain *why*, never *what*. Prefer good naming.
- Keep the dependency list short; `npm install` only when genuinely needed.

## Testing conventions

- Vitest, `pool: forks` for module isolation.
- Tests live in `test/` mirroring `src/`.
- Keep the implementation clean of test seams. Confirm with the user if absolutely needed.
- Optimize for critical paths (pipeline, tool execution, store round-trip). No coverage targets.
- `test/setup.ts` preloads `src/infra/config.ts` before anything else (logger reads settings eagerly) and clears registries in `afterEach`.
- `test/helpers/{tmp,stores,turn}.ts` for tmp dirs, store init, minimal TurnContext.
- Module mocking: `vi.hoisted()` + `vi.mock("../relative/path.ts", ...)`. For settings overrides, mutate the live `settings` object directly in `beforeEach`.

## Commands

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
```

## What Klaus is

A maximally simple, headless personal AI agent: **WhatsApp → TypeScript → Obsidian vault → Docker**.

Stack: Node 25, native TypeScript, strict TypeScript, Zod, Handlebars, Baileys. Models via a thin custom loop against any OpenAI-compatible `/chat/completions` endpoint (default only OpenRouter); request/response types come from the `openrouter` sdk. Liteparse for docs, sharp for images. JSONL for conversations/reports, JSON for schedules/timers. No database.

## Docs layout

```
README.md                  # public front door
docs/setup.md              # install, first boot, WhatsApp login, troubleshooting
docs/architecture.md       # high-level map of runtime and authoring surfaces
docs/codebase/pipeline.md  # turn flow, config, context, model loop, agent runs
docs/codebase/primitives.md # commands, variables, tools, toolsets, server tools
docs/codebase/infra.md     # config, vault/sync, WhatsApp, stores, logging
docs/vault/agents.md       # agent frontmatter, prompts, schedules, persistence
docs/vault/prompts.md      # snippets and skills
docs/vault/templates.md    # message/history/help/error/welcome/report templates
docs/vault/settings.md     # settings.yml and overrides.yml
docs/vault/reports.md      # reports and debugging
```

## Directory layout
The repo is itentionally flat and opinionated in structure. One glance and a new user should be able to find where to look.

```
src/
├── index.ts          # bootstrap
├── errors.ts         # user-facing error formatting
├── pipeline/         # per-turn orchestration
│   ├── index.ts      # handleTurn — auth + full turn
│   ├── message.ts    # parseMessage (STT, commands, /next, @agent, !overrides)
│   ├── next.ts       # single-use per-chat prefix for the next non-command message
│   ├── overrides.ts  # TurnConfig + !preset registry + merge
│   ├── agents.ts     # Agent schema + registry + default-agent
│   ├── context.ts    # variables + tools + history assembly
│   ├── templates.ts  # system/user message rendering
│   ├── core.ts       # core model loop (runAgent, executeAgent, persist) + TurnContext + Trigger
│   ├── dispatch.ts   # scheduled/timer/agent-run entrypoint
│   ├── media.ts      # STT, doc parsing, image prep
│   └── reports.ts    # per-turn report emitter
├── primitives/       # pluggable extensions (auto-discovered via glob)
│   ├── tools/        # send_message, set_reaction, search_messages, read_skill + sets/{vault,agents,files}
│   ├── variables/    # time, media, tasks, dispatch, config, snippets, trigger
│   └── commands/     # /break, /default, /help, /image, /model, /next, /provider, /resume, /retry, /schedules, /stop, /voice
└── infra/            # external systems + state
    ├── config.ts     # YAML settings + env paths + resolveModel/resolveImageModel (live mutable `settings`)
    ├── logger.ts
    ├── store/        # flat-file stores (history, files, report, schedules, timers)
    ├── vault/        # path resolution, permissions, markdown helpers, file watcher, Obsidian sync
    └── whatsapp/     # connection, send queue, receive (+ InboundMessage), presence, login
```

## Message flow

1. **Auth** — allowlist (fail-closed). Unset → setup mode; self-mode auto-resolves own JID.
2. **Parse** — `parseMessage`: STT transcribe → doc extract → image/sticker vision media → `/command` → `/next` prefix for non-command messages → `@agent` → `!overrides`.
3. **Resolve agent + build config** — `getOrLoadAgent` + `buildTurnConfig` (globalDefaults → frontmatter → `!overrides`).
4. **Persist message** — append to day-partitioned JSONL, resolve quoted media.
5. **Execute agent** — `executeAgent`: assemble context (vars + tools + history) → compile prompts → `runLoop` (multi-step `completeChat` calls until the model stops calling tools) → recover plain assistant content as a visible fallback `send_message` when that tool is active → report → reschedule if persistent.

Scheduled runs, timers, persistence, and `run_agent` start at step 5 with a synthesised `Trigger`.
Frontmatter schedules render `# Message` with `{{schedule.*}}`; timer and agent-task runs prefer `# Message` with `{{dispatch.prompt}}`, falling back to the raw objective when no `# Message` exists.
Inline `run_agent` messages return to the caller as the tool result; only schedule/timer runs send directly to WhatsApp. The `send_message` tool requires final `text`, can include `asVoiceNote: true` for voice delivery, and only uses integer `quoteMessageLabel` when explicitly quoting an older WhatsApp message by positive visible `ref #n` history metadata; omit it for normal messages. `quoteMessageLabel: 0` is accepted but ignored so agents do not quote the current message by habit. `forceVoice` and `suppressVoice` override voice choice. TTS output format is set by `media.voice.tts.responseFormat`; PCM responses are converted from 24 kHz, 16-bit mono PCM to Ogg Opus before WhatsApp voice-note send.

## Agents

`.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

Bundled first-run agents:
- `assistant` — general daily driver.
- `research` (`@r`) — read-oriented web/vault investigation and synthesis.
- `meta` (`@m`) — edits the user-owned `Klaus/` configuration folder.
- `dispatch` (`@d`) — generic delegated worker used by `run_agent`.

```yaml
---
name: agentName
aliases: [short]
tools: [send_message, set_reaction]
toolsets: [vault, agents]
serverTools: [web_search]
skills: [workout-plan]
provider: Codex|openai|gemini|qwen|deepseek
modelTier: small|medium|large
voice: on|auto|off
temp: cold|default|hot
topP: creative|default|rigid
reasoningEffort: low|default|high
historyLimit: 20
historyScope: full|agent
showTools: true
report: true|false
vaultAccess:
  - "*:full"
  - "Private:none"
persist: true
persistHint: "reschedule based on user's next workout"
persistOverrides: [voice]
schedules:
  - pattern: "0 8 * * *"
    label: morning
    overrides: [voice]
---
# System
Stable agent instructions with {{var}} Handlebars interpolation.

# Message
Scheduled-run message with {{schedule.label}} metadata.
```

Persistence:
- `schedules` — recurring cron entries fire with the agent's `# Message` as the synthetic user message. Timer and `run_agent` runs also use `# Message` when present, with `{{dispatch.prompt}}` carrying the objective.
- `persist: true` — after each run, a forced `persist` tool call produces `{nextRun, prompt, overrides?}`; one-shot timer created, chain unbreakable.

## Primitives

**Tools** are model-callable functions with Zod input schemas. Keep tool behavior explicit in the name and description, and return clear values the model can act on.

**Server tools** (e.g. `web_search`, `web_fetch`) are OpenRouter server tools — they get appended verbatim to the request's `tools` array (`{ type: "openrouter:web_search" }`) and execute server-side; the agent loop never sees a client-side tool_call for them. Declared per agent in `serverTools: […]`. Reports show the declared server tools separately from local tools and include OpenRouter-exposed server-tool usage/citations when the Chat Completions response surfaces them.

**Toolsets** are lazy-loaded via `load_<name>` meta-tools so the initial context stays lean.

**Skills** are `.md` docs in `{vault}/Klaus/skills/`, loaded via a per-agent `read_skill` tool scoped to the agent's declared list.

**Snippets** are `.md` fragments in `{vault}/Klaus/snippets/`, compiled once against the normal variable namespace. Use `{{snippets.name}}` in agent prompts; snippets do not expand other snippets.

**Variables** produce the unified `{{namespace}}` for templates. One file per top-level key in `src/primitives/variables/`. User messages also support `$var.sub.path` shortcut syntax.

**Overrides** are `!preset` words in messages, defined in `Klaus/overrides.yml`. Parsed out, merged into `TurnConfig` on top of agent frontmatter defaults. Reserved for pipeline/agent behavior — NOT for prompt content. Aliases resolve at parse time.

**Commands** are `/command` handlers that bypass the LLM. Auto-discovered from `src/primitives/commands/`. `/next <prefix>` arms a single-use prefix for the next non-command message, mostly for voice-note agent routing and overrides. `/stop` (`/kill`) is the panic button: it aborts active runs and pauses schedules/timers without deleting persisted state; `/resume` re-arms them.

**Extension pattern** — drop a file, export the right shape, restart. No wiring.

## Reports

One JSON file per run at `{dataDir}/logs/<date>/<file>.json` when `turn.config.report !== false`. Reports include message metadata, overrides, variable summaries, explicit local tools, server tools, toolsets, skills, LLM steps, local tool calls/results, server-tool usage/citations when OpenRouter exposes them, and rendered system prompt + user message + history transcript for spotting injection or format bugs. Toolset members stay grouped in the context summary; individual local calls still appear in the step trace with returned values. Inline agent-task messages show up as the parent `run_agent` tool result. Image data URLs are redacted from text mirrors; the message wrapper records readable media metadata such as `input: image filename` when available. `send_message` step args keep short metadata such as `asVoiceNote` before long `text` so truncation stays readable.

`settings.reports.vaultMarkdown: true` mirrors each report into `{vault}/Klaus/reports/<date>/<file>.md` for Obsidian reading.

## Storage

| Store | Format | Purpose |
|---|---|---|
| `history` | JSONL, day-partitioned | Conversation events (msg, ack, reaction, trace, break); assistant voice rows carry `voice: true` |
| `report` | JSONL, day-partitioned | Per-turn execution record |
| `files` | JSONL index + blobs | File metadata + content on disk |
| `schedules` | JSON + croner | Recurring cron jobs |
| `timers` | JSON + setTimeout | One-shot future execution |

All under `{dataDir}` (`./data` locally, `/data` in production/Docker, or `KLAUS_DATA_DIR` when set). The vault is separate — it's the knowledge graph (notes, wikilinks, frontmatter). Its root follows the same pattern: `./vault` locally, `/vault` in production/Docker, or `KLAUS_VAULT_DIR` when set.

History reaction events target WhatsApp external IDs and are rendered as metadata on their real message rows. Bot reactions carry `agent` and `runId` when available, so reaction-only turns stay visible in future context without consuming separate `historyLimit` slots. If an agent reacts to a user message without sending a real reply, history rendering adds a transient assistant cue for the model only; it is not stored and has no quoteable `ref #n`.

When `showTools` is enabled, assistant history rows with persisted traces get a compact names-only `toolSummary` such as `search_messages, read_note`; tool arguments and results remain report-only.

Quoted context is persisted on user rows from WhatsApp quoted text, the stored original message, or a short media descriptor such as `quoted image`. Bundled history templates use the existing `{{trunc ...}}` helper to keep long quoted snippets, message bodies, and document extracts from bloating future turns.

Schedules and timers store future work, not chat routing. Klaus has one configured chat; fired runs resolve `settings.allowedChat` at execution time. Future-work clocks stay paused until setup has produced `settings.allowedChat` and WhatsApp is connected, and pause again during reconnects. Repeated checks in the same wait state log only once.

## Vault layout (`{vault}/Klaus/`)

```
agents/       # agent .md files
skills/       # on-demand reference docs
snippets/     # prompt fragments compiled into {{snippets.<name>}}
templates/    # message-user.md, message-agent.md, history-user.md,
              # history-agent.md, persistence.md, report.md, error.md, welcome.md
reports/      # optional vault-markdown report mirror
overrides.yml # !preset definitions
settings.yml  # YAML settings (hot-reloaded via Zod validation)
```

`ensureDefaults()` checks only whether the vault's internal `Klaus/` folder exists. If it does not exist, it copies the repo's `vault/` tree once. If `Klaus/` exists, the whole folder is user-owned state: do not merge repo defaults into it, do not backfill files, and do not overwrite user edits.

Runtime settings are read from `{vault}/Klaus/settings.yml` after startup vault sync/hydration. Startup fails if the synced settings file is invalid. If startup says settings are invalid or missing while sync downloaded `Klaus/settings.yml`, debug path resolution, file contents, YAML parsing, and strict Zod validation. Do not solve this class of issue by merging the defaults folder.

Templates are required — `runAgent()` throws if `message-user.md` etc. are missing.
