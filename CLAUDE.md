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

1. **Auth** — allowlist check (fail-closed)
2. **Rate limit** — per-chat message/min guard
3. **Normalize** — transcribe voice notes (STT), downscale large images
4. **Voice rewrite** — for voice transcripts only: fuzzy-match spoken agent/flag patterns into canonical `@agent`/`!flag` tokens (`src/core/voice-parse.ts`). Trigger words configurable via `settings.stt.agentTriggers` and `settings.stt.flagTriggers`
5. **Parse commands** — `/command` handlers bypass LLM, return early
6. **Parse routing** — extract `@agentName` prefix, `!flags` from text, resolve flag overrides
7. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
8. **Apply modes** — merge agent frontmatter modes (voiceMode, acceptMode, provider) into overrides; per-message flags take precedence
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
voiceMode: auto               # auto (agent decides) | on (always TTS) | off (never TTS) | fixed (TTS above character threshold)
acceptMode: off               # off (ask for confirmation) | on (auto-accept)
provider: claude              # optional: preferred provider (claude, chatgpt, gemini)
showToolsInContext: true      # optional: include tool usage in conversation context (default true)
---
Prompt body with {{contextVar}} Handlebars interpolation (supports params: {{contextVar?key=val}}).
```

`agentRegistry` (Map<name, AgentDefinition>) is populated at startup from all `.md` files, indexing both canonical names and aliases. The `runAgent()` function loads the prompt, builds system prompt via Handlebars, registers tools, drives the Vercel AI SDK agentic loop, and returns an `AgentRunResult` with pipeline metadata (usage, duration, steps, model info).

**Persistent agents** (`persistent: true`) use AI SDK `Output.object()` to force the model to produce a structured `{ nextRun, objective }` declaration as its final step. After execution, the system automatically creates a one-shot timer for `nextRun` (delay string or ISO datetime, clamped to min/max bounds from `settings.persistent`). If the model call fails or output parsing fails, a fallback timer is created at `settings.persistent.defaultNextRun`. Existing timers for the same agent+chatId are cancelled before scheduling to prevent accumulation. This guarantees persistent agents never silently stop — the chain is unbreakable.

**Toolsets** are groups of tools loaded lazily via meta-tools (e.g., `use_vault`). Defined in `src/tools/sets/`.

**Skills** are static `.md` reference documents in `{vault}/Klaus/skills/` with optional YAML frontmatter (`description:` field). Agents that declare `skills:` in frontmatter get a `skill_get` tool scoped to those names via `z.enum`. Skill descriptions are included in the tool description to help the model decide when to load. The `{{skills}}` Handlebars var is injected so agents can list available skills in the prompt. Zero token overhead for agents without skills.

**Flags** are code-defined programmatic overrides that control pipeline/agent behavior for the current message. Users activate flags with `!flagName` or `!alias` in their message (e.g. `!voice`/`!v`, `!large`/`!l`, `!clean`/`!cl`). `src/core/flags.ts` defines the static `flagRegistry` (Map<name|alias, FlagDef>), the `FlagOverrides` interface, and `resolveOverrides()` which maps parsed flags to typed effects. Aliases resolve to canonical names at parse time — downstream code only sees canonical names. Overrides are applied at specific pipeline/agent execution points (model tier, provider, TTS, conversation history, temperature, topP, reasoning effort, speed, tool choice, confirmation gating, persistence) rather than injected as prompt text. Temperature and topP flags resolve to presets (`"cold"|"hot"`, `"creative"|"rigid"`) that are resolved per-provider in `agent.ts` using `providerCfg.coldTemperature`/`hotTemperature`/`creativeTopP`/`rigidTopP`. Reasoning effort and fast mode resolve to provider-specific `providerOptions` in `agent.ts` (Anthropic `effort`/`speed`, OpenAI `reasoningEffort`, Google `thinkingConfig.thinkingLevel`; unsupported combos log a warning and are ignored). Current flags (with aliases): `!voice` (`!v`), `!clean` (`!cl`), `!small|medium|large` (`!s|m|l`), `!claude|chatgpt|gemini` (no aliases), `!accept` (`!a`), `!cold|hot` (`!c|h`), `!creative|rigid` (`!cr|r`), `!low|high` (`!lo|hi`), `!fast` (`!f`), `!no-tools|use-tools` (`!nt|ut`), `!ghost` (`!g`).

**Modes** are persistent, agent-level behavioral defaults stored in frontmatter. They act as default overrides that per-message flags can still override. `voiceMode` controls TTS output (`auto`/`on`/`off`/`fixed`), `acceptMode` controls confirmation gating (`on`/`off`), and `provider` sets the preferred LLM provider. `fixed` mode automatically sends replies as TTS when they exceed `settings.tts.fixedVoiceThreshold` characters (default: 200). Resolution order: per-message flag → agent frontmatter mode → global settings. `src/core/modes.ts` defines `applyModeDefaults()` which merges mode defaults into `FlagOverrides` after flag parsing. The `{{modes}}` context variable injects active modes into prompts so agents are aware of their configuration. Commands `/voice` and `/accept` modify frontmatter of the default agent (same pattern as `/model`).

**Commands** are `/command` handlers that bypass the LLM entirely. Defined in `src/commands/` and registered in `src/commands/register.ts`. Current commands (with aliases): `/status` (`/s`), `/tasks` (`/t`), `/default`, `/model` (`/m`), `/models`, `/voice` (`/v`), `/accept` (`/a`), `/help` (`/?`), `/break` (`/b`). Each command implements the `Command` interface (name, aliases, description, execute). Aliases are indexed alongside canonical names in the `CommandRegistry`.

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new context variable = new file implementing `ContextVariable`. Extend by adding, not modifying.

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
| `src/core/flags.ts` | Flag registry — code-defined programmatic overrides (FlagDef, FlagOverrides, resolveOverrides) |
| `src/core/pipeline.ts` | Message orchestrator |
| `src/core/agent.ts` | Agent executor + agentRegistry |
| `src/core/assemble.ts` | Context assembly — runs context variables in parallel (with params), enforces token budget |
| `src/core/interpolate.ts` | `$var` user message interpolation, `?params` extraction, HBS param stripping |
| `src/core/registry.ts` | Tool + toolset registry, meta-tool generation, dynamic tool loading |
| `src/core/dispatch.ts` | Unified dispatch function (inline/async modes) |
| `src/core/model-router.ts` | LLM call routing (provider-agnostic via provider-factory) |
| `src/core/provider-factory.ts` | SDK factory — lazy-loads `@ai-sdk/{anthropic,openai,google}` by name |
| `src/core/modes.ts` | Mode resolution — merges agent frontmatter modes into FlagOverrides |
| `src/core/frontmatter.ts` | YAML frontmatter field read/write helper |
| `src/core/queue.ts` | In-memory job queue + active job tracking |
| `src/core/voice-parse.ts` | Voice transcript fuzzy matching — rewrites spoken agent/flag patterns to canonical tokens |
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

### Project boundaries

- `/whatsapp` — pure transport, no business logic
- `/core` — pipeline, agent engine, queue, middleware
- `/store` — flat-file storage, JSONL read/write, schedules, timers, indexes
- `/tools` — each tool/tool-set in its own file or folder
- `/context` — one file per context variable
- `{vault}/Klaus/agents/` — markdown prompt files with YAML frontmatter
- `{vault}/Klaus/skills/` — static `.md` reference documents loaded on demand via `skill_get`
- `{vault}/Klaus/snippets/` — prompt content with optional YAML frontmatter (`scope:` `system`|`user`|`both`, default: `system`). System-scoped → `{{var}}` in prompts; user-scoped → `$var` in messages. Snippet content supports Handlebars templating with turn context vars: `voiceMode`, `acceptMode`, `provider`, `forceVoice`, `suppressVoice`, `autoAccept`, `ghost`, `isVoiceOn`, `isVoiceOff`, `isVoiceAuto`, `isVoiceFixed`. Compiled in a first pass before agent prompt assembly (two-pass, no recursion risk). Static snippets (no `{{`) skip compilation.
- `{vault}/Klaus/trail/` — daily markdown turn logs for cross-device debugging (auto-managed, retention-limited)
- `{vault}/Klaus/message.md` — Handlebars template for user message formatting (voice note prefix, quoted text, media info). Falls back to hardcoded format if missing.
- `{vault}/Klaus/settings.yml` — user-facing settings (providers, context budgets, rate limits, etc.), hot-reloaded with Zod validation
- `{vault}/Klaus/user.md` — user profile, updated by memorize agent

Live Vault is located at /Users/janbassen/Vaults/Jan/Klaus on this pc

### Deployment

Published as `janbassen1/klaus` on Docker Hub. The Dockerfile includes OCI labels and a VERSION build arg that is exposed via the `/healthz` endpoint. The container runs as non-root (`USER bun`). `LOG_FORMAT=json` is recommended for NAS log viewers.

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
- User-facing settings live in `Klaus/settings.yml` (vault), loaded and validated by `src/core/settings-loader.ts`. Infrastructure config (env-derived paths, log format) lives in `src/config.ts`. `src/settings.ts` is a thin getter layer composing both — all consumers import `{ settings }` from it unchanged. The `modelTiers` array (`"small" | "medium" | "large" | "vision"`) and `ModelTier` type are static literals in `settings.ts`. Providers are configured as named entries under `settings.providers` (each with `sdk`, `small`, `medium`, `large`, `vision` model fields, plus optional randomness controls: `temperature`, `coldTemperature`, `hotTemperature`, `topP`, `creativeTopP`, `rigidTopP`). `resolveProvider(override?)` returns the provider config by name (falls back to global active provider). Provider preference is stored per-agent in frontmatter, resolved via `applyModeDefaults()`. Never inline magic numbers — add them to the Zod schema defaults in `settings-loader.ts`.
- One concern per file
- Path alias `@/` maps to `src/`
- No unnecessary comments — code should be self-explanatory; comments explain *why*, never *what*
- Keep the dependency list short; justify every addition — use `bun add` / `bun update`, no need to check versions manually
