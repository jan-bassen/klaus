# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (uses 1Password for env secrets)
op run --env-file=.env -- bun run src/index.ts

# Type checking
bun run typecheck

# Tests
bun run test

# Run a single test file
bun test src/__tests__/pipeline.test.ts

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

Every inbound WhatsApp message goes through a pipeline in `src/core/pipeline.ts`:

1. **Auth** — allowlist check (fail-closed). When `allowedChatId` is unset (in settings.yml or env), enters **setup mode**: replies with the sender's chat ID and setup instructions instead of silently dropping. **Self-mode** (`whatsapp.selfMode: true`): for users running Klaus on their own number — auto-resolves JID, processes `fromMe` messages (with loop prevention via sent-ID tracking), and prefixes all outbound text with `[AgentName]:` or `[System]:`
2. **Rate limit** — per-chat message/min guard
3. **Normalize** — transcribe voice notes (STT), downscale large images
4. **Voice rewrite** — for voice transcripts only: fuzzy-match spoken agent name into canonical `@agent` prefix (`src/core/voice-parse.ts`). Trigger words configurable via `settings.stt.agentTriggers`
5. **Parse commands** — `/command` handlers bypass LLM, return early
6. **Parse routing** — extract `@agentName` prefix, `!overrides` from text, resolve override presets
7. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
8. **Apply defaults** — merge agent frontmatter override defaults into resolved overrides; per-message `!` overrides take precedence
9. **Persist** — append message to day-partitioned conversation JSONL, resolve quote-reply
10. **Assemble context** — extract `?params` from prompt template + user message, run all context variables in parallel (with params), trim to token budget
11. **Execute agent** — `runAgent()` via Vercel AI SDK agentic loop
12. **Log** — record structured turn log (routing, context, LLM steps, outcome) to `{dataDir}/logs/`

### Agent system (core/agent.ts)

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

**overrides** are data-driven overrides that control pipeline/agent behavior for the current message. Users activate them with `!name` or `!alias` in their message (e.g. `!voice`/`!v`, `!large`/`!l`, `!clean`/`!cl`). Presets are defined in `{vault}/Klaus/overrides.yaml` — each entry maps a name to aliases, description, and an `overrides` map of `overrides` fields. At startup (and on hot-reload), `loadoverrides()` parses the YAML, validates each entry with Zod, and registers into `overrideRegistry` (Map<name|alias, overrideDef>). `resolveoverrides()` merges the `overrides` maps of active presets. Parsing (`parseoverrides`, `stripoverrides`) is in `src/core/overrides.ts`. Aliases resolve to canonical names at parse time. overrides are applied at specific pipeline/agent execution points (model tier, provider, TTS, conversation history, temperature, topP, reasoning effort, speed, tool choice, confirmation gating, persistence). Temperature and topP resolve to presets (`"cold"|"hot"`, `"creative"|"rigid"`) per-provider in `agent.ts`. Reasoning effort and fast mode resolve to provider-specific `providerOptions`. Current overrides (with aliases): `!voice` (`!v`), `!clean` (`!cl`), `!small|medium|large` (`!s|m|l`), `!claude|chatgpt|gemini` (no aliases), `!accept` (`!a`), `!cold|hot` (`!c|h`), `!creative|rigid` (`!cr|r`), `!low|high` (`!lo|hi`), `!fast` (`!f`), `!no-tools|use-tools` (`!nt|ut`), `!ghost` (`!g`). Agent frontmatter can set any `overrides` field directly as a default (e.g. `forceVoice: true`, `autoAccept: true`). Resolution: agent frontmatter defaults → per-message `!override` → final. `resolveAgentDefaults()` in `src/core/overrides.ts` handles the merge. All resolved values are automatically available as `{{fieldName}}` template vars in agent prompts and snippets via `turn.templateVars` (computed once by `buildTemplateVars()` in `src/core/overrides.ts`, seeded into assembled vars by `assemble.ts`). Derived convenience vars: `{{isVoiceOn}}`, `{{isVoiceOff}}`, `{{isVoiceAuto}}`, `{{provider}}`. Commands `/voice` and `/accept` modify agent frontmatter directly (`forceVoice`/`suppressVoice`/`autoAccept` fields).

**Commands** are `/command` handlers that bypass the LLM entirely. Defined in `src/commands/` and registered in `src/commands/register.ts`. Current commands (with aliases): `/status` (`/s`), `/tasks` (`/t`), `/default`, `/model` (`/m`), `/models`, `/voice` (`/v`), `/accept` (`/a`), `/help` (`/?`), `/break` (`/b`). Each command implements the `Command` interface (name, aliases, description, execute). Aliases are indexed alongside canonical names in the `CommandRegistry`.

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new context variable = new file implementing `ContextVariable`; new override = new entry in `Klaus/overrides.yaml`. Extend by adding, not modifying.

**Reference:** `REFERENCE.md` contains an exhaustive list of all commands, overrides, context variables, tools, toolsets, and settings with their parameters and defaults. Keep it in sync when adding or changing primitives.

### Storage (src/store/)

All operational data is stored as flat files — no database.

| Module | Format | Purpose |
|--------|--------|---------|
| `conversation.ts` | Day-partitioned JSONL (msg/ack/reaction/trace/break events) | Chat history with break markers and in-memory indexes |
| `jsonl.ts` | Date-partitioned JSONL | Generic append/read utilities |
| `turn-log.ts` | Date-partitioned JSONL | Structured per-turn execution record (routing, context, LLM steps, outcome) |
| `trail.ts` | Day-partitioned Markdown in vault `Klaus/trail/` | Human-readable turn trail for Obsidian debugging (auto-cleanup, configurable retention) |
| `date-utils.ts` | — | Timezone-aware date string utility |
| `files.ts` | JSONL index + blob storage | File metadata |
| `schedules.ts` | JSON + croner cron jobs | Recurring schedule persistence |
| `timers.ts` | JSON + setTimeout | One-time future execution |

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter is metadata. Vault tools provide search, read, write, and link traversal. The vault has folder-level permissions (`read|append|full`) with optional elevated access via WhatsApp reaction confirmation. The internal folder (`Klaus/`) containing agents, skills, and snippets is separate but accessible (default: read, request: full).

### Logging

Two distinct systems — don't conflate them:

- **`log`** (`src/logger.ts`) — transient console output for live monitoring (`docker logs`, terminal). Operational health: auth failures, rate limits, routing decisions, errors. Pretty-printed in dev, JSON in production (`LOG_FORMAT=json`).
- **Turn log** (`src/store/turn-log.ts`) — persistent structured JSONL record per user turn. Full execution trace: prompts, tool calls, token usage, reply content. Written to `{dataDir}/logs/turn-YYYY-MM-DD.jsonl`. Use for debugging, auditing, and cost analysis.
- **Trail** (`src/store/trail.ts`) — human-readable markdown mirror of turn logs written to `{vault}/Klaus/trail/trail-YYYY-MM-DD.md`. Syncs to Obsidian for cross-device debugging. Configurable via `settings.trail` (`enabled`, `retentionDays`). Old files auto-cleaned on each write.

### Key modules

| Path | Concern |
|------|---------|
| `src/types.ts` | All core interfaces (InboundMessage, TurnContext, AgentDefinition, ToolDefinition, ContextVariable) |
| `src/settings.ts` | Thin getter layer — composes `config.ts` (infra) + YAML settings from vault |
| `src/config.ts` | Env-derived infrastructure: vault paths, dataDir, log format, startup timing |
| `src/core/settings-loader.ts` | Loads + validates `Klaus/settings.yml` via Zod, hot-reloads on change, WhatsApp warnings on invalid config |
| `src/core/overrides.ts` | override definitions, YAML loader, registry, parser, resolver (overrideDef, overrides) |
| `src/core/pipeline.ts` | Message orchestrator |
| `src/core/agent.ts` | Agent executor + agentRegistry |
| `src/core/assemble.ts` | Context assembly — runs context variables in parallel (with params), enforces token budget |
| `src/core/interpolate.ts` | `$var` user message interpolation, `?params` extraction, HBS param stripping |
| `src/core/registry.ts` | Tool + toolset registry, meta-tool generation, dynamic tool loading |
| `src/core/dispatch.ts` | Unified dispatch function (inline/async modes) |
| `src/core/model-router.ts` | LLM call routing (provider-agnostic via provider-factory) |
| `src/core/provider-factory.ts` | SDK factory — lazy-loads `@ai-sdk/{anthropic,openai,google}` by name |
| `src/core/frontmatter.ts` | YAML frontmatter field read/write helper |
| `src/core/queue.ts` | In-memory job queue + active job tracking |
| `src/core/voice-parse.ts` | Voice transcript fuzzy matching — rewrites spoken agent name to canonical `@agent` prefix |
| `src/core/vault-access.ts` | Vault path resolution, folder-level permission checks, confirmation gating |
| `src/core/watcher.ts` | File watcher for hot-reloading agents and skills |
| `src/store/` | Flat-file storage modules (conversations, schedules, timers, files, etc.) |
| `src/context/` | Context variable modules (inject dynamic content into prompts) |
| `src/tools/` | Tool definitions + toolset loaders |
| `src/tools/skill.ts` | `buildSkillTool()` — per-agent skill.get tool builder |
| `src/tools/sets/dispatch.ts` | `dispatch` toolset: `dispatch.agent`, `dispatch.schedule`, `dispatch.timer`, `dispatch.list`, `dispatch.cancel` |
| `src/tools/conversation.ts` | Standalone tool: search conversation history (text, around message, time range) |
| `src/commands/` | /command handlers |
| `src/commands/register.ts` | Registers all commands into the command registry |
| `src/whatsapp/` | Transport layer (Baileys connection, send, receive, TTS, STT, presence) |
| `src/whatsapp/login.ts` | Vault-based login flow (QR code SVG to vault, login folder setup) |

### Project boundaries

- `/whatsapp` — pure transport, no business logic
- `/core` — pipeline, agent engine, queue, middleware
- `/store` — flat-file storage, JSONL read/write, schedules, timers, indexes
- `/tools` — each tool/tool-set in its own file or folder
- `/context` — one file per context variable
- `{vault}/Klaus/agents/` — markdown prompt files with YAML frontmatter
- `{vault}/Klaus/skills/` — static `.md` reference documents loaded on demand via `skill_get`
- `{vault}/Klaus/snippets/` — prompt content with optional YAML frontmatter (`scope:` `system`|`user`|`both`, default: `system`). System-scoped → `{{var}}` in prompts; user-scoped → `$var` in messages. Snippet content supports Handlebars templating with all `turn.templateVars` (e.g. `{{forceVoice}}`, `{{provider}}`, `{{modelTier}}`, `{{isVoiceOn}}`, `{{isVoiceOff}}`, `{{isVoiceAuto}}`). Compiled in a first pass before agent prompt assembly (two-pass, no recursion risk). Static snippets (no `{{`) skip compilation.
- `{vault}/Klaus/overrides.yaml` — override preset definitions (name → aliases + overrides map), hot-reloaded via file watcher
- `{vault}/Klaus/trail/` — daily markdown turn logs for cross-device debugging (auto-managed, retention-limited)
- `{vault}/Klaus/message.md` — Handlebars template for user message formatting (voice note prefix, quoted text, media info). Falls back to hardcoded format if missing.
- `{vault}/Klaus/settings.yml` — user-facing settings (providers, context budgets, rate limits, etc.), hot-reloaded with Zod validation
- `{vault}/Klaus/user.md` — user profile, updated by memorize agent

Live Vault is located at /Users/janbassen/Vaults/Jan/Klaus on this pc

### Deployment

Published as `janbassen1/klaus` on Docker Hub. The Dockerfile includes OCI labels and a VERSION build arg that is exposed via the `/healthz` endpoint. The container runs as non-root (`USER bun`). `LOG_FORMAT=json` is recommended for NAS log viewers.

HTTP endpoints: `/healthz` (JSON health check). Login is handled via the vault: QR codes are written to `{vault}/Klaus/_login/qr-code.svg` for scanning via Obsidian.

### Testing conventions

- Tests mirror source tree under `src/__tests__/`
- Write tests alongside the code being developed, not after
- Mocks must be registered **before** importing the module under test (Bun mock hoisting)
- Mock at the `store/*` boundary for unit tests (e.g., `mock.module("@/store/conversation", ...)`)
- Clean up registries in `afterEach` (agentRegistry, toolRegistry)
- No coverage targets — optimize for confidence in the critical paths: pipeline, middleware, store read/write, tool execution
- Agent evals (`*.eval.ts`) test non-deterministic behavior — not CI-blocking, tracked over time
- Test timeout: 30s (bunfig.toml)

### Code conventions

- No barrel files — import from specific module paths
- Errors are values — return don't throw (except at true system boundaries)
- No `any` types; explicit return types on exported functions
- Prefer `const` and pure functions; minimize mutable state
- User-facing settings live in `Klaus/settings.yml` (vault), loaded and validated by `src/core/settings-loader.ts`. Infrastructure config (env-derived paths, log format) lives in `src/config.ts`. `src/settings.ts` is a thin getter layer composing both — all consumers import `{ settings }` from it unchanged. The `modelTiers` array (`"small" | "medium" | "large" | "vision"`) and `ModelTier` type are static literals in `settings.ts`. Providers are configured as named entries under `settings.providers` (each with `sdk`, `small`, `medium`, `large`, `vision` model fields, plus optional randomness controls: `temperature`, `coldTemperature`, `hotTemperature`, `topP`, `creativeTopP`, `rigidTopP`). `resolveProvider(override?)` returns the provider config by name (falls back to global active provider). Provider preference is stored per-agent in frontmatter, resolved via `resolveAgentDefaults()`. Never inline magic numbers — add them to the Zod schema defaults in `settings-loader.ts`.
- One concern per file
- Path alias `@/` maps to `src/`
- No unnecessary comments — code should be self-explanatory; comments explain *why*, never *what*
- Keep the dependency list short; justify every addition — use `bun add` / `bun update`, no need to check versions manually
