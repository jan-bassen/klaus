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

Bun, TypeScript (strict), Baileys, Vercel AI SDK. Containerized as a single Docker image (`janbassen1/klaus`).

Storage: JSONL flat files for operational data (conversations, invocations), JSON files for schedules and timers, Obsidian vault for knowledge (notes, wikilinks, tags as the knowledge graph).

### Message flow (pipeline.ts)

Every inbound WhatsApp message goes through a pipeline in `src/core/pipeline.ts`:

1. **Auth** — allowlist check (fail-closed)
2. **Rate limit** — per-chat message/min guard
3. **Normalize** — transcribe voice notes (STT), downscale large images
4. **Parse commands** — `/command` handlers bypass LLM, return early
5. **Parse routing** — extract `@agentName` prefix and `!flags` from text
6. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
7. **Persist** — append message to conversation JSONL, resolve quote-reply
8. **Assemble context** — all context variables run in parallel, trimmed to token budget
9. **Execute agent** — `runAgent()` via Vercel AI SDK agentic loop

### Agent system (core/agent.ts)

Agents are defined as `.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

```yaml
---
name: agentName
modelTier: default|low|high    # maps to model IDs in settings.ts
tools: [reply, send, react]
toolsets: [vault, dispatch]    # expands to use_* meta-tools; tools loaded lazily
providerTools: [web_search]    # Anthropic built-ins
skills: [workout-plan]        # on-demand .md docs from {vault}/Klaus/skills/
schedule: "0 3 * * *"         # optional cron
persistent: true              # optional: forces structured nextRun output, auto-reschedules
vaultScope: "Training"        # optional: restricts all vault tools to this subdirectory
---
Prompt body with {{contextVar}} Handlebars interpolation.
```

`agentRegistry` (Map<name, AgentDefinition>) is populated at startup from all `.md` files. The `runAgent()` function loads the prompt, builds system prompt via Handlebars, registers tools, and drives the Vercel AI SDK agentic loop.

**Persistent agents** (`persistent: true`) use AI SDK `Output.object()` to force the model to produce a structured `{ nextRun, objective }` declaration as its final step. After execution, the system automatically creates a one-shot timer for `nextRun` (delay string or ISO datetime, clamped to min/max bounds from `settings.persistent`). If the model call fails or output parsing fails, a fallback timer is created at `settings.persistent.defaultNextRun`. Existing timers for the same agent+chatId are cancelled before scheduling to prevent accumulation. This guarantees persistent agents never silently stop — the chain is unbreakable.

**Toolsets** are groups of tools loaded lazily via meta-tools (e.g., `use_vault`). Defined in `src/tools/sets/`.

**Skills** are static `.md` reference documents in `{vault}/Klaus/skills/` with optional YAML frontmatter (`description:` field). Agents that declare `skills:` in frontmatter get a `skill_get` tool scoped to those names via `z.enum`. Skill descriptions are included in the tool description to help the model decide when to load. The `{{skills}}` Handlebars var is injected so agents can list available skills in the prompt. Zero token overhead for agents without skills.

**Flags** are `.md` files in `{vault}/Klaus/flags/` with a `description:` frontmatter field and a body that is injected into the prompt when active. Users activate flags with `!flagName` in their message. `src/core/flags.ts` manages the `flagRegistry` (Map<name, FlagMeta>), loaded at startup and hot-reloaded by the watcher. Flag text is stripped from the user message and injected via `buildUserMessageText` in the pipeline.

**Commands** are `/command` handlers that bypass the LLM entirely. Defined in `src/commands/` and registered in `src/commands/register.ts`. Current commands: `/status`, `/tasks`, `/default`, `/help`, `/new`. Each command implements the `Command` interface (name, description, execute).

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new context variable = new file implementing `ContextVariable`. Extend by adding, not modifying.

### Storage (src/store/)

All operational data is stored as flat files — no database.

| Module | Format | Purpose |
|--------|--------|---------|
| `conversation.ts` | JSONL (msg/ack/reaction/trace events) | Chat history with in-memory indexes |
| `jsonl.ts` | Date-partitioned JSONL | Generic append/read utilities |
| `invocations.ts` | JSONL | LLM call traces |
| `files.ts` | JSONL index + blob storage | File metadata |
| `schedules.ts` | JSON + croner cron jobs | Recurring schedule persistence |
| `timers.ts` | JSON + setTimeout | One-time future execution |

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter is metadata. Vault tools provide search, read, write, and link traversal. The vault has folder-level permissions (`read|append|full`) with optional elevated access via WhatsApp reaction confirmation. The internal folder (`Klaus/`) containing agents, skills, snippets, and flags is separate but accessible (default: read, request: full).

### Key modules

| Path | Concern |
|------|---------|
| `src/types.ts` | All core interfaces (InboundMessage, TurnContext, AgentDefinition, ToolDefinition, ContextVariable) |
| `src/settings.ts` | Thin getter layer — composes `config.ts` (infra) + YAML settings from vault |
| `src/config.ts` | Env-derived infrastructure: vault paths, dataDir, log format, startup timing |
| `src/core/settings-loader.ts` | Loads + validates `Klaus/settings.yml` via Zod, hot-reloads on change, WhatsApp warnings on invalid config |
| `src/core/flags.ts` | Flag registry — loads `.md` flag definitions from vault, hot-reloaded |
| `src/core/pipeline.ts` | Message orchestrator |
| `src/core/agent.ts` | Agent executor + agentRegistry |
| `src/core/assemble.ts` | Context assembly — runs context variables in parallel, enforces token budget |
| `src/core/registry.ts` | Tool + toolset registry, meta-tool generation, dynamic tool loading |
| `src/core/dispatch.ts` | Unified dispatch function (inline/async modes) |
| `src/core/model-router.ts` | LLM call routing |
| `src/core/queue.ts` | In-memory job queue + active job tracking |
| `src/core/vault-access.ts` | Vault path resolution, folder-level permission checks, confirmation gating |
| `src/core/watcher.ts` | File watcher for hot-reloading agents, skills, and flags |
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
- `{vault}/Klaus/flags/` — `.md` flag definitions with `description:` frontmatter, hot-reloaded
- `{vault}/Klaus/snippets/` — static prompt content (soul.md, architecture.md) injected as template vars
- `{vault}/Klaus/settings.yml` — user-facing settings (models, context budgets, rate limits, etc.), hot-reloaded with Zod validation
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
- User-facing settings live in `Klaus/settings.yml` (vault), loaded and validated by `src/core/settings-loader.ts`. Infrastructure config (env-derived paths, log format) lives in `src/config.ts`. `src/settings.ts` is a thin getter layer composing both — all consumers import `{ settings }` from it unchanged. The `modelTiers` array and `ModelTier` type are static literals in `settings.ts`. Never inline magic numbers — add them to the Zod schema defaults in `settings-loader.ts`.
- One concern per file
- Path alias `@/` maps to `src/`
- No unnecessary comments — code should be self-explanatory; comments explain *why*, never *what*
- Keep the dependency list short; justify every addition — use `bun add` / `bun update`, no need to check versions manually
