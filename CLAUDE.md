# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (uses 1Password for env secrets)
op run --env-file=.env -- bun run src/index.ts

# Type checking
bun run typecheck

# Tests (Vitest)
bun run test

# Run a single test file
npx vitest run test/pipeline/pipeline.test.ts

# Watch mode
bun run test:watch

# Linting/formatting (Biome)
bunx biome check --write .

# Publish to Docker Hub (builds linux/amd64, pushes :version + :latest)
bun run publish
```

## Git workflow

One logical change = one PR = one commit. A change is not done until all of the following are included together:

- The implementation itself
- Tests for the new/changed behavior (in `src/__tests__/`)
- Updates to README.md if the change affects setup, architecture, or public-facing behavior
- Updates to this file (CLAUDE.md) if the change affects conventions, commands, or architecture
- Any TODO/task list updates if the project tracks open work

Do not split these across multiple PRs or commits. Do not submit a feature and leave tests, docs, or housekeeping for a follow-up — include everything in the same PR.

Before opening a PR, run `bun run typecheck`, `bun run test`, and `bunx biome check --write .` and fix any failures.

## Architecture

Klaus is a headless personal AI agent: WhatsApp messages → TypeScript pipeline → Obsidian Vault + LLM → response.

### Stack

Bun, TypeScript (strict), Baileys, Vercel AI SDK (multi-provider: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`). Containerized as a single Docker image (`janbassen1/klaus`).

Storage: JSONL flat files for operational data (conversations, invocations), JSON files for schedules and timers, Obsidian vault for knowledge (notes, wikilinks, tags as the knowledge graph).

### Message flow (pipeline.ts)

Every inbound WhatsApp message goes through a pipeline in `src/pipeline/index.ts`:

1. **Auth** — allowlist check (fail-closed). When `allowedChatId` is unset (in settings.yml or env), enters **setup mode**: replies with the sender's chat ID and setup instructions instead of silently dropping. **Self-mode** (`whatsapp.selfMode: true`): for users running Klaus on their own number — auto-resolves JID, processes `fromMe` messages (with loop prevention via sent-ID tracking), and prefixes all outbound text with `[AgentName]:` or `[System]:`
2. **Rate limit** — per-chat message/min guard
3. **Normalize** — transcribe voice notes (STT), parse attached documents to text (liteparse, cached as `.parsed.txt` sidecar next to the blob), fetch web links (defuddle for readability extraction, in-memory cache). Images pass through; documents surface as `media.extractedText` on the inbound message, and as `{{media.doc.text}}` in templates via the `media` variable. Web links surface as `links` on the inbound message and as `{{links.items}}` in templates via the `links` variable.
4. **Voice rewrite** — for voice transcripts only: fuzzy-match spoken agent name into canonical `@agent` prefix (`src/whatsapp/voice.ts`). Trigger words configurable via `settings.stt.agentTriggers`
5. **Parse commands** — `/command` handlers bypass LLM, return early
6. **Parse routing** — extract `@agentName` prefix, `!overrides` from text, resolve override presets
7. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
8. **Apply defaults** — merge agent frontmatter override defaults into resolved overrides; per-message `!` overrides take precedence
9. **Persist** — append message to day-partitioned conversation JSONL, resolve quote-reply
10. **Assemble context** — extract `?params` from prompt template + user message, run all context variables in parallel (with params), trim to token budget
11. **Execute agent** — `runAgent()` via Vercel AI SDK agentic loop
12. **Log** — record structured turn log (routing, context, LLM steps, outcome) to `{dataDir}/logs/`

### Agent system (agent/)

Agents are defined as `.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

```yaml
---
name: agentName
aliases: [short, s]           # optional shorthand names (e.g. @s instead of @agentName)
modelTier: small|medium|large  # maps to model IDs in active provider config
tools: [reply, send, react]
toolsets: [vault, dispatch]    # expands to use_* meta-tools; tools loaded lazily
providerTools: [web_search]    # provider built-ins (canonical names, resolved per provider)
skills: [workout-plan]        # on-demand .md docs from {vault}/Klaus/skills/
schedule: "0 3 * * *"         # optional cron
persistent: true              # optional: forces structured nextRun output, auto-reschedules
vaultScope: "Training"        # optional: restricts all vault tools to this subdirectory
provider: claude              # optional: preferred provider (claude, chatgpt, gemini)
forceVoice: true              # optional: always reply as voice (TTS)
suppressVoice: true           # optional: never reply as voice
autoAccept: true              # optional: auto-accept confirmation prompts
showToolsInContext: true      # optional: include tool usage in conversation context (default true)
---
Prompt body with {{contextVar}} Handlebars interpolation (supports params: {{contextVar?key=val}}).
```

`agentRegistry` (Map<name, AgentDefinition>) is populated at startup from all `.md` files, indexing both canonical names and aliases. The `runAgent()` function loads the prompt, builds system prompt via Handlebars, registers tools, drives the Vercel AI SDK agentic loop, and returns an `AgentRunResult` with pipeline metadata (usage, duration, steps, model info).

**Persistent agents** (`persistent: true`) use AI SDK `Output.object()` to force the model to produce a structured `{ nextRun, objective }` declaration as its final step. After execution, the system automatically creates a one-shot timer for `nextRun` (delay string or ISO datetime, clamped to min/max bounds from `settings.persistent`). If the model call fails or output parsing fails, a fallback timer is created at `settings.persistent.defaultNextRun`. Existing timers for the same agent+chatId are cancelled before scheduling to prevent accumulation. This guarantees persistent agents never silently stop — the chain is unbreakable.

**Toolsets** are groups of tools loaded lazily via meta-tools (e.g., `use_vault`). Defined in `src/tools/sets/`.

**Skills** are static `.md` reference documents in `{vault}/Klaus/skills/` with optional YAML frontmatter (`description:` field). Agents that declare `skills:` in frontmatter get a `skill_get` tool scoped to those names via `z.enum`. Skill descriptions are included in the tool description to help the model decide when to load. The `{{skills}}` Handlebars var is injected so agents can list available skills in the prompt. Zero token overhead for agents without skills.

**Overrides** are data-driven presets that control pipeline/agent behavior for the current message. Users activate them with `!name` or `!alias` in their message (e.g. `!voice`/`!v`, `!large`/`!l`, `!clean`/`!cl`). Presets are defined in `{vault}/Klaus/overrides.yml` — each entry maps a name to aliases, description, and an `overrides` map of `TurnConfig` fields. At startup (and on hot-reload), `loadOverrides()` parses the YAML, validates each entry with Zod, and registers into `overrideRegistry` (Map<name|alias, OverrideDef>). `resolveOverrides()` merges the `overrides` maps of active presets into a single partial `TurnConfig`. Parsing (`parseOverrides`, `stripOverrides`) is in `src/pipeline/overrides.ts`. Aliases resolve to canonical names at parse time. Overrides are applied at specific pipeline/agent execution points (model tier, provider, TTS, conversation history, temperature, topP, reasoning effort, speed, tool choice, confirmation gating, persistence). Temperature and topP resolve to presets (`"cold"|"hot"`, `"creative"|"rigid"`) per-provider in `agent/runner.ts`. Reasoning effort and fast mode resolve to provider-specific `providerOptions`. Current overrides (with aliases): `!voice` (`!v`), `!clean` (`!cl`), `!small|medium|large` (`!s|m|l`), `!claude|chatgpt|gemini` (no aliases), `!accept` (`!a`), `!cold|hot` (`!c|h`), `!creative|rigid` (`!cr|r`), `!low|high` (`!lo|hi`), `!fast` (`!f`), `!no-tools|use-tools` (`!nt|ut`), `!ghost` (`!g`). Agent frontmatter can set any `TurnConfig` field directly as a default (e.g. `forceVoice: true`, `autoAccept: true`). Resolution: agent frontmatter defaults → per-message `!override` → final. `resolveAgentDefaults()` in `src/pipeline/overrides.ts` handles the merge and produces the effective `TurnConfig` carried on `TurnContext.config`. On `TurnContext`, `config: TurnConfig` is the effective turn configuration that all downstream code reads; `overrides: Record<string, boolean>` is the raw list of active preset names, used only for logging and the `message.md` template. The `config` variable surfaces `TurnContext.config` in templates (e.g. `{{config.forceVoice}}`, `{{config.modelTier}}`, `{{config.provider}}`, plus derived `{{config.isVoiceOn}}`, `{{config.isVoiceOff}}`, `{{config.isVoiceAuto}}`) — templates consume the resolved state without caring about provenance. Commands `/voice` and `/accept` modify agent frontmatter directly (`forceVoice`/`suppressVoice`/`autoAccept` fields).

**Variables** are named producers of data injected into Handlebars templates. Each lives in `src/variables/<key>.ts` and exports a `Variable` whose `key` becomes the top-level namespace entry — the `run()` result lands at `vars[key]`. All templates (agent prompt, `message.md`, snippets) see the same unified nested namespace; reference with `{{time.date}}`, `{{media.doc.text}}`, `{{tasks.active}}`, `{{config.isVoiceOn}}`, etc. User-typed message text supports `$name` and `$name.sub.path` shortcuts against the same namespace. Variables run in parallel; set `after: true` on a `Variable` to defer into a second phase that receives the partial namespace via `turn.vars` (used by `snippets` to compile snippets against the full namespace). There is no token budget or priority — apply explicit char caps in templates with `{{trunc value 5000}}`. Current variables: `time` (date/time/weekday), `media` (attached doc/image/voice + quoted-media mime), `links` (auto-fetched web links from message text: count + items with url/title/text), `tasks` (active jobs + timers), `dispatch` (caller/objective for dispatched runs, `null` otherwise), `config` (effective turn config: voice flags, provider, model, all resolved overrides), `user` (user profile from `snippets/user.md`), `snippets` (all other `snippets/*.md` compiled with the full namespace).

**Commands** are `/command` handlers that bypass the LLM entirely. Defined in `src/commands/` and auto-discovered via glob at startup (same pattern as tools and variables). Current commands (with aliases): `/status` (`/s`), `/tasks` (`/t`), `/default`, `/model` (`/m`), `/models`, `/voice` (`/v`), `/accept` (`/a`), `/help` (`/?`), `/break` (`/b`), `/retry` (`/r`). Each command implements the `Command` interface (name, aliases, description, execute). Aliases are indexed alongside canonical names in the `CommandRegistry`.

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new variable = new file implementing `Variable`; new command = new file implementing `Command`; new override = new entry in `Klaus/overrides.yml`. All code-level primitives (tools, variables, commands) are auto-discovered via glob — drop a file, export the right shape, restart. Extend by adding, not modifying.

**Reference:** `REFERENCE.md` contains an exhaustive list of all commands, overrides, variables, tools, toolsets, and settings with their parameters and defaults. Keep it in sync when adding or changing primitives.

### Storage (src/store/)

All operational data is stored as flat files — no database.

| Module | Format | Purpose |
|--------|--------|---------|
| `index.ts` | — | JSONL append/read utilities + timezone-aware date string helper |
| `conversation.ts` | Day-partitioned JSONL (msg/ack/reaction/trace/break/supersede events) | Chat history with break markers, per-message supersede (for `/retry`), and in-memory indexes |
| `turn-log.ts` | Date-partitioned JSONL | Structured per-turn execution record (routing, context, LLM steps, outcome) |
| `trail.ts` | Day-partitioned Markdown in vault `Klaus/trail/` | Human-readable turn trail for Obsidian debugging (auto-cleanup, configurable retention) |
| `files.ts` | JSONL index + blob storage | File metadata |
| `schedules.ts` | JSON + croner cron jobs | Recurring schedule persistence |
| `timers.ts` | JSON + setTimeout | One-time future execution |

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter is metadata. Vault tools provide search, read, write, and link traversal. The vault has folder-level permissions (`read|append|full`) with optional elevated access via WhatsApp reaction confirmation. The internal folder (`Klaus/`) containing agents, skills, and snippets is separate but accessible (default: read, request: full).

### Key modules

| Path | Concern |
|------|---------|
| `src/types.ts` | Cross-cutting interfaces (InboundMessage, TurnContext, TurnResult) + re-exports of domain types |
| `src/errors.ts` | `formatUserError` — maps LLM errors to user-friendly messages |
| `src/markdown.ts` | Handlebars instance + helpers (`trunc`, `limit`, logic, comparisons), YAML frontmatter read/write, `$var` user-message interpolation with dot-path support |
| `src/config/index.ts` | Public API: `settings`, `resolveProvider()`, `ModelTier`, `modelTiers`, `createModel()` |
| `src/config/env.ts` | Env-derived infrastructure: vault paths, dataDir, log format, startup timing |
| `src/config/schema.ts` | Loads + validates `Klaus/settings.yml` via Zod, hot-reloads on change |
| `src/config/providers.ts` | SDK factory — lazy-loads `@ai-sdk/{anthropic,openai,google}` by name |
| `src/pipeline/index.ts` | Message orchestrator (inlined allowlist check) |
| `src/pipeline/overrides.ts` | Override definitions, YAML loader, registry, parser, resolver (overrideDef, overrides) |
| `src/pipeline/attachments.ts` | `parseDocument()` — liteparse wrapper with `.parsed.txt` sidecar cache, mime allow-list, char truncation. `fetchWebContent()` — defuddle-based web link fetching with in-memory cache, timeout, body size limit. `extractUrls()` — URL extraction from message text. |
| `src/pipeline/rate-limit.ts` | Sliding window rate limiter |
| `src/agent/index.ts` | AgentFrontmatterSchema, agentRegistry, loading, AgentDefinition |
| `src/agent/runner.ts` | `runAgent()` execution loop (tool setup, provider options, AI SDK call, persistent scheduling) |
| `src/agent/messages.ts` | `buildConversationMessages()` — conversation history reconstruction |
| `src/agent/model.ts` | LLM call routing (provider-agnostic via provider factory) |
| `src/agent/dispatch.ts` | Unified dispatch function (inline/async modes), DispatchMode/DispatchOptions |
| `src/agent/queue.ts` | In-memory job queue + active job tracking |
| `src/variables/index.ts` | Variable assembly — runs all `Variable`s in parallel, plus an optional `after` phase. Produces the unified nested namespace consumed by every template. Defines the `Variable` interface. |
| `src/variables/links.ts` | `links` variable — exposes auto-fetched web link content (count + items with url/title/text) |
| `src/tools/index.ts` | Tool + toolset registry, meta-tool generation, dynamic tool loading. ToolDefinition/ToolsetDefinition types |
| `src/tools/skill.ts` | `buildSkillTool()` — per-agent skill.get tool builder |
| `src/tools/sets/dispatch.ts` | `dispatch` toolset: `dispatch.agent`, `dispatch.schedule`, `dispatch.timer`, `dispatch.list`, `dispatch.cancel` |
| `src/tools/conversation.ts` | Standalone tool: search conversation history (text, around message, time range) |
| `src/tools/web.ts` | Standalone tool: `web.fetch` — fetch and parse a web page via defuddle |
| `src/vault/index.ts` | Vault path resolution, folder-level permission checks, confirmation gating |
| `src/vault/watcher.ts` | File watcher for hot-reloading agents, skills, overrides |
| `src/store/` | Flat-file storage modules (conversations, schedules, timers, files, etc.) |
| `src/variables/` | Variable modules (one file per top-level namespace key) |
| `src/commands/index.ts` | CommandRegistry + self-registration of all /command handlers |
| `src/whatsapp/` | Transport layer (Baileys connection, send, receive, presence) |
| `src/whatsapp/voice.ts` | STT (Scribe), TTS (ElevenLabs), voice transcript rewriting |
| `src/whatsapp/send.ts` | Send queue (FIFO, dedup, retry), reactions, OutboundMessage type |
| `src/whatsapp/login.ts` | Vault-based login flow (QR code SVG to vault, login folder setup) |

### Project boundaries

- `/whatsapp` — pure transport (connection, send, receive, voice STT/TTS, presence), no business logic
- `/pipeline` — message orchestrator, overrides, rate limiting
- `/agent` — agent definitions, executor, dispatch, model routing, job queue
- `/config` — settings (env + YAML), provider factory
- `/vault` — vault access, file watcher, hot-reload
- `/store` — flat-file storage, JSONL read/write, schedules, timers, indexes
- `/tools` — each tool/tool-set in its own file or folder, tool/toolset registries
- `/variables` — unified variable namespace: one file per top-level key, plus the assembler
- `{vault}/Klaus/agents/` — markdown prompt files with YAML frontmatter
- `{vault}/Klaus/skills/` — static `.md` reference documents loaded on demand via `skill_get`
- `{vault}/Klaus/snippets/` — reusable prompt fragments. Each `*.md` is compiled through Handlebars against the full assembled namespace and exposed as `{{snippets.<filename>}}`. `user.md` is special-cased by the `user` variable → `{{user.profile}}`. Static snippets (no `{{`) skip compilation.
- `{vault}/Klaus/overrides.yml` — override preset definitions (name → aliases + overrides map), hot-reloaded via file watcher
- `{vault}/Klaus/trail/` — daily markdown turn logs for cross-device debugging (auto-managed, retention-limited)
- `{vault}/Klaus/message.md` — Handlebars template for user message formatting (voice note prefix, quoted text, attached media). Required — `runAgent()` throws a clear error if it's missing so setup is explicit. Has full access to the unified variable namespace (e.g. `{{media.doc.text}}`, `{{trunc media.doc.text 5000}}`).
- `{vault}/Klaus/settings.yml` — user-facing settings (providers, context budgets, rate limits, etc.), hot-reloaded with Zod validation
- `{vault}/Klaus/user.md` — user profile, updated by memorize agent

Live Vault is located at /Users/janbassen/Vaults/Jan/Klaus on this pc

### Deployment

Published as `janbassen1/klaus` on Docker Hub. The Dockerfile includes OCI labels and a VERSION build arg that is exposed via the `/healthz` endpoint. The container runs as non-root (`USER bun`). `LOG_FORMAT=json` is recommended for NAS log viewers.

HTTP endpoints: `/healthz` (JSON health check). Login is handled via the vault: QR codes are written to `{vault}/Klaus/_login/qr-code.svg` for scanning via Obsidian.

### Testing conventions

- Tests live in `test/` at the project root, grouped by domain (agent/, pipeline/, tools/, etc.)
- Test runner: Vitest (`vitest.config.ts`), pool: forks for module isolation
- Write tests alongside the code being developed, not after
- Module mocking: use `vi.hoisted()` for mock functions referenced in `vi.mock()` factories, then `vi.mock("@/path", () => ({ fn: mockFn }))`
- Mock at the `store/*` boundary for unit tests
- `test/bun-polyfill.ts` shims Bun-specific APIs (Bun.file, Bun.write, Bun.Glob) for the Node runtime
- Clean up registries in `afterEach` (agentRegistry, toolRegistry)
- No coverage targets — optimize for confidence in the critical paths: pipeline, middleware, store read/write, tool execution
- Test timeout: 30s (vitest.config.ts)

### Code conventions

- No barrel files — import from specific module paths
- Errors are values — return don't throw (except at true system boundaries)
- No `any` types; explicit return types on exported functions
- Prefer `const` and pure functions; minimize mutable state
- `Klaus/settings.yml` (at the repo root) is the single source of truth for all tunable settings. It ships with the repo and is copied into `{vault}/Klaus/settings.yml` on first run by `ensureDefaults()` in `src/index.ts`. The Zod schema in `src/config/schema.ts` only *validates* — it holds no `.default()` fallbacks. Every field must be present in settings.yml. Tests load the bundled default via `_resetForTest()`. Infrastructure config (env-derived paths, log format) lives in `src/config/env.ts`. `src/config/index.ts` is the public API composing both — all consumers import `{ settings }` from `@/config`. The `modelTiers` array (`"small" | "medium" | "large"`) and `ModelTier` type are static literals in `config/index.ts`. Providers are configured as named entries under `settings.providers` (each with `sdk`, `small`, `medium`, `large` model fields, plus optional randomness controls: `temperature`, `coldTemperature`, `hotTemperature`, `topP`, `creativeTopP`, `rigidTopP`). `resolveProvider(override?)` returns the provider config by name (falls back to global active provider). Provider preference is stored per-agent in frontmatter, resolved via `resolveAgentDefaults()`. Never inline magic numbers — add them to `Klaus/settings.yml` and add the corresponding validation field to `config/schema.ts`.
- One concern per file
- Path alias `@/` maps to `src/`
- No unnecessary comments — code should be self-explanatory; comments explain *why*, never *what*
- Keep the dependency list short; justify every addition — use `bun add` / `bun update`, no need to check versions manually
