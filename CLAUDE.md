# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
bun run typecheck
bun run test
bun run test:watch
bunx biome check --write .
bun run build
bun run publish
```

## What Klaus is

A maximally simple, headless personal AI agent: **WhatsApp → TypeScript → Obsidian vault → Docker**.

Stack: Bun, TypeScript strict, Zod, Handlebars, Baileys. Models via a thin custom loop against any OpenAI-compatible `/chat/completions` endpoint (default OpenRouter); request/response types come from the `openai` npm package (devDep, types-only) with small extensions for OpenRouter-specific bits (`reasoning.effort`, `openrouter:web_search` / `openrouter:web_fetch` server tools). Liteparse for docs, sharp for images. JSONL for conversations/reports, JSON for schedules/timers. No database.

## Directory layout

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
│   ├── agent.ts      # core model loop (runAgent, executeAgent, persist) + TurnContext + Trigger
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
    ├── vault/        # path resolution, permissions, markdown helpers, file watcher
    └── whatsapp/     # connection, send queue, receive (+ InboundMessage), presence, login
```

## Message flow

1. **Auth** — allowlist (fail-closed). Unset → setup mode; self-mode auto-resolves own JID.
2. **Parse** — `parseMessage`: STT transcribe → doc extract → link fetch → voice transcript rewrite → `/command` → `@agent` → `!overrides`.
3. **Resolve agent + build config** — `getOrLoadAgent` + `buildTurnConfig` (globalDefaults → frontmatter → `!overrides`).
4. **Persist message** — append to day-partitioned JSONL, resolve quoted media.
5. **Execute agent** — `executeAgent`: assemble context (vars + tools + history) → compile prompts → `runLoop` (multi-step `completeChat` calls until the model stops calling tools) → report → reschedule if persistent.

Dispatched runs (cron, timer, `dispatch` tool) start at step 5 with a synthesised `Trigger`.

## Agents

`.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

```yaml
---
name: agentName
aliases: [short]
tools: [reply, react]
toolsets: [vault, dispatch]
providerTools: [web_search]
skills: [workout-plan]
settings:
  provider: claude|openai|gemini|qwen|deepseek
  modelTier: small|medium|large
  voice: on|auto|off
  temp: cold|default|hot
  topP: creative|default|rigid
  reasoningEffort: low|default|high
  historyLimit: 20
  historyScope: full|agent
  showTrace: true
  report: full|agent|none
  vault: {"*": full, "Private": none}
persistence:
  mode: static
  schedule: "0 3 * * *"
  prompt: "daily check-in"
  overrides: [voice]
  # OR
  # mode: dynamic
  # hint: "reschedule based on user's next workout"
---
Prompt body with {{var}} Handlebars interpolation.
```

Persistence:
- `static` — cron fires at `schedule` with fixed `prompt` + `overrides`.
- `dynamic` — after each run, a forced `persist` tool call produces `{nextRun, prompt, overrides?}`; one-shot timer created, chain unbreakable.

## Primitives

**Tools** declare `sideEffect: "external" | "stateful" | "pure"` (enforced at registration). Under `!simulate`, `external`/`stateful` calls route through the per-turn simulation overlay — either a custom `simulate` handler or a generic faker. `pure` passes through.

**Provider tools** (e.g. `web_search`, `web_fetch`) are OpenRouter server tools — they get appended verbatim to the request's `tools` array (`{ type: "openrouter:web_search" }`) and execute server-side; the agent loop never sees a client-side tool_call for them. Declared per agent in `providerTools: […]`.

**Toolsets** are lazy-loaded via `use_<name>` meta-tools so the initial context stays lean.

**Skills** are `.md` docs in `{vault}/Klaus/skills/`, loaded via a per-agent `skill_get` tool scoped to the agent's declared list.

**Variables** produce the unified `{{namespace}}` for templates. One file per top-level key in `src/primitives/variables/`. User messages also support `$var.sub.path` shortcut syntax.

**Overrides** are `!preset` words in messages, defined in `Klaus/overrides.yml`. Parsed out, merged into `TurnConfig` on top of agent frontmatter defaults. Reserved for pipeline/agent behavior — NOT for prompt content. Aliases resolve at parse time.

**Commands** are `/command` handlers that bypass the LLM. Auto-discovered from `src/primitives/commands/`.

**Extension pattern** — drop a file, export the right shape, restart. No wiring.

## Reports

Per-turn JSONL at `{dataDir}/logs/<date>.jsonl`. Three levels (`turn.config.report`):
- `none` — skip
- `agent` — LLM call only (model, tokens, steps, tool calls)
- `full` — also message metadata, overrides, variables summary, and **verbatim** system prompt + user message + history transcript (for spotting injection / format bugs)

Sim runs always set `simulation: true` and carry the `simulatedActions` list from the overlay.

`settings.reports.vaultMarkdown: true` mirrors each report into `{vault}/Klaus/reports/<date>.md` for Obsidian reading.

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

All under `{dataDir}` (default `~/.klaus/data`). The vault is separate — it's the knowledge graph (notes, wikilinks, frontmatter).

## Vault layout (`{vault}/Klaus/`)

```
agents/       # agent .md files
skills/       # on-demand reference docs
snippets/     # prompt fragments compiled into {{snippets.<name>}}
templates/    # message-user.md, report-short.md, report-full.md,
              # error-message.md
reports/      # optional vault-markdown report mirror
overrides.yml # !preset definitions
settings.yml  # YAML settings (hot-reloaded via Zod validation)
```

`ensureDefaults()` copies the repo's `vault/` tree into the vault's internal `Klaus/` folder on first run. User edits are never overwritten.

Templates are required — `runAgent()` throws if `message-user.md` etc. are missing.

## Testing conventions

- Vitest, `pool: forks` for module isolation.
- Tests live in `test/` mirroring `src/`.
- `test/setup.ts` preloads `@/infra/config` before anything else (logger reads settings eagerly) and clears registries in `afterEach`.
- `test/helpers/{tmp,stores,turn}.ts` for tmp dirs, store init, minimal TurnContext.
- Module mocking: `vi.hoisted()` + `vi.mock("@/path", ...)`. For settings overrides, mutate the live `settings` object directly in `beforeEach`.
- Optimize for critical paths (pipeline, tool execution, store round-trip). No coverage targets.

## Code conventions

- No barrel files — import from specific module paths. Path alias `@/` → `src/`.
- Errors are values — `return` them; only throw at true system boundaries.
- No `any`. Explicit return types on exported functions.
- One concern per file.
- `vault/settings.yml` (repo) is the single source of truth for tunable settings; at runtime it's overlaid with the user's `{vault}/Klaus/settings.yml`. Zod validates only — no `.default()` fallbacks. Add new fields here + in `src/infra/config.ts`'s schema.
- No inline magic numbers — route through `settings.*`.
- Comments explain *why*, never *what*. Prefer good naming.
- Keep the dependency list short; `bun add` only when genuinely needed.

## Live vault

The user's live vault is at `/Users/janbassen/Vaults/Jan/Klaus`. Code changes never touch it directly — it syncs via `ensureDefaults()` copy or the user's manual Obsidian sync.
