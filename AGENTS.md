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
docs/codebase/pipeline.md  # turn flow, config, context, model loop, dispatch
docs/codebase/primitives.md # commands, variables, tools, toolsets, provider tools
docs/codebase/infra.md     # config, vault/sync, WhatsApp, stores, simulation
docs/vault/agents.md       # agent frontmatter, prompts, schedules, persistence
docs/vault/prompts.md      # snippets and skills
docs/vault/templates.md    # message/history/help/error/welcome/report templates
docs/vault/settings.md     # settings.yml and overrides.yml
docs/vault/reports.md      # reports, simulation output, debugging
```

## Directory layout
The repo is itentionally flat and opinionated in structure. One glance and a new user should be able to find where to look.

```
src/
├── index.ts          # bootstrap
├── errors.ts         # user-facing error formatting
├── pipeline/         # per-turn orchestration
│   ├── index.ts      # handleTurn — auth + full turn
│   ├── message.ts    # parseMessage (STT, @agent, !overrides, commands)
│   ├── overrides.ts  # TurnConfig + !preset registry + merge
│   ├── agents.ts     # Agent schema + registry + default-agent
│   ├── context.ts    # variables + tools + history assembly
│   ├── prompts.ts    # system/user message rendering
│   ├── core.ts       # core model loop (runAgent, executeAgent, persist) + TurnContext + Trigger
│   ├── dispatch.ts   # dispatch() primitive
│   ├── media.ts      # STT, doc parsing, image prep
│   └── reports.ts    # per-turn report emitter
├── primitives/       # pluggable extensions (auto-discovered via glob)
│   ├── tools/        # reply, react, web, conversation, skill + sets/{vault,dispatch,files}
│   ├── variables/    # time, media, links, tasks, dispatch, config, user, snippets, trigger
│   └── commands/     # /status, /tasks, /voice, /model, /provider, /break, /retry, /reports, /help, /default
└── infra/            # external systems + state
    ├── config.ts     # YAML settings + env paths + resolveModel/resolveImageModel (live mutable `settings`)
    ├── logger.ts
    ├── simulation.ts # per-turn overlay (WeakMap<TurnContext>) + fakers
    ├── store/        # flat-file stores (history, files, report, schedules, timers)
    ├── vault/        # path resolution, permissions, markdown helpers, file watcher, Obsidian sync
    └── whatsapp/     # connection, send queue, receive (+ InboundMessage), presence, login
```

## Message flow

1. **Auth** — allowlist (fail-closed). Unset → setup mode; self-mode auto-resolves own JID.
2. **Parse** — `parseMessage`: STT transcribe → doc extract → link fetch → voice transcript rewrite → `/command` → `@agent` → `!overrides`.
3. **Resolve agent + build config** — `getOrLoadAgent` + `buildTurnConfig` (globalDefaults → frontmatter → `!overrides`).
4. **Persist message** — append to day-partitioned JSONL, resolve quoted media.
5. **Execute agent** — `executeAgent`: assemble context (vars + tools + history) → compile prompts → `runLoop` (multi-step `completeChat` calls until the model stops calling tools) → recover plain assistant content as a visible fallback `reply` when reply is active → report → reschedule if persistent.

Dispatched runs (cron, timer, `dispatch` tool) start at step 5 with a synthesised `Trigger`.
Frontmatter schedules render `# Message` with `{{schedule.*}}`; timer and dispatch-tool runs prefer `# Message` with `{{dispatch.prompt}}`, falling back to the raw objective when no `# Message` exists.

## Agents

`.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

Bundled first-run agents:
- `assistant` — general daily driver.
- `research` (`@r`) — read-oriented web/vault investigation and synthesis.
- `meta` (`@m`) — edits the user-owned `Klaus/` configuration folder.
- `dispatch` (`@d`) — generic delegated worker used by the dispatch tool.

```yaml
---
name: agentName
aliases: [short]
tools: [reply, react]
toolsets: [vault, dispatch]
providerTools: [web_search]
skills: [workout-plan]
provider: Codex|openai|gemini|qwen|deepseek
modelTier: small|medium|large
voice: on|auto|off
voiceId: optional ElevenLabs voice ID for this agent
temp: cold|default|hot
topP: creative|default|rigid
reasoningEffort: low|default|high
historyLimit: 20
historyScope: full|agent
showTrace: true
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
- `schedules` — recurring cron entries fire with the agent's `# Message` as the synthetic user message. Timer and dispatch-tool runs also use `# Message` when present, with `{{dispatch.prompt}}` carrying the objective.
- `persist: true` — after each run, a forced `persist` tool call produces `{nextRun, prompt, overrides?}`; one-shot timer created, chain unbreakable.

## Primitives

**Tools** declare `sideEffect: "external" | "stateful" | "pure"` (enforced at registration). Under `!simulate`, `external`/`stateful` calls route through the per-turn simulation overlay — either a custom `simulate` handler or a generic faker. `pure` passes through.

**Provider tools** (e.g. `web_search`, `web_fetch`) are OpenRouter server tools — they get appended verbatim to the request's `tools` array (`{ type: "openrouter:web_search" }`) and execute server-side; the agent loop never sees a client-side tool_call for them. Declared per agent in `providerTools: […]`.

**Toolsets** are lazy-loaded via `load_<name>` meta-tools so the initial context stays lean.

**Skills** are `.md` docs in `{vault}/Klaus/skills/`, loaded via a per-agent `skill_get` tool scoped to the agent's declared list.

**Variables** produce the unified `{{namespace}}` for templates. One file per top-level key in `src/primitives/variables/`. User messages also support `$var.sub.path` shortcut syntax.

**Overrides** are `!preset` words in messages, defined in `Klaus/overrides.yml`. Parsed out, merged into `TurnConfig` on top of agent frontmatter defaults. Reserved for pipeline/agent behavior — NOT for prompt content. Aliases resolve at parse time.

**Commands** are `/command` handlers that bypass the LLM. Auto-discovered from `src/primitives/commands/`.

**Extension pattern** — drop a file, export the right shape, restart. No wiring.

## Reports

One JSON file per run at `{dataDir}/logs/<date>/<file>.json` when `turn.config.report !== false`. Reports include message metadata, overrides, variable summaries, LLM steps, tool calls, and **verbatim** system prompt + user message + history transcript for spotting injection or format bugs.

Sim runs always set `simulation: true` and carry the `simulatedActions` list from the overlay.

`settings.reports.vaultMarkdown: true` mirrors each report into `{vault}/Klaus/reports/<date>/<file>.md` for Obsidian reading.

## Simulation (`!simulate` / `!sim`)

Try actions with real data, no real consequences. Reports always emitted, tagged `SIM`.

Elevates `ghost: true` + `skipHistory: true` — neither the user message nor the trace persist. Inline dispatch propagates `simulate` into sub-agents automatically.

Overlay gives read-from-write coherence: a `vault_write` followed by `vault_read` sees the pending content. Same for dispatch timers/schedules and file uploads.

## Storage

| Store | Format | Purpose |
|---|---|---|
| `history` | JSONL, day-partitioned | Conversation events (msg, ack, reaction, trace, break) |
| `report` | JSONL, day-partitioned | Per-turn execution record |
| `files` | JSONL index + blobs | File metadata + content on disk |
| `schedules` | JSON + croner | Recurring cron jobs |
| `timers` | JSON + setTimeout | One-shot future execution |

All under `{dataDir}` (default `./data`). The vault is separate — it's the knowledge graph (notes, wikilinks, frontmatter).

Schedules and timers store future work, not chat routing. Klaus has one configured chat; fired runs resolve `settings.allowedChat` at execution time. Future-work clocks stay paused until setup has produced `settings.allowedChat` and WhatsApp is connected, and pause again during reconnects.

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
