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

Storage: JSONL flat files for operational data (conversations, costs, invocations), file-based task queue, Obsidian vault for knowledge (notes, wikilinks, tags as the knowledge graph).

### Message flow (pipeline.ts)

Every inbound WhatsApp message goes through a pipeline in `src/core/pipeline.ts`:

1. **Auth** — allowlist check
2. **Rate limit** — message/min guard
3. **Normalize** — voice → text (STT), image downscale
4. **Parse commands** — `/command` handlers bypass LLM
5. **Parse routing** — `@agentName` prefix, `!flags` extraction
6. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
7. **Assemble context** — all context variables run in parallel, trimmed to token budget
8. **Execute agent** — `runAgent()` via Vercel AI SDK agentic loop

### Agent system (core/agent.ts)

Agents are defined as `.md` files in `{vault}/Klaus/agents/` with YAML frontmatter:

```yaml
---
name: agentName
modelTier: default|low|high    # maps to model IDs in config.ts
tools: [reply, send, react]
toolsets: [vault, tasks]       # expands to use_* meta-tools; tools loaded lazily
providerTools: [web_search]    # Anthropic built-ins
skills: [workout-plan]        # on-demand .md docs from {vault}/Klaus/skills/
schedule: "0 3 * * *"         # optional cron
vaultScope: "Training"        # optional: restricts all vault tools to this subdirectory
---
Prompt body with {{contextVar}} Handlebars interpolation.
```

`agentRegistry` (Map<name, AgentDefinition>) is populated at startup from all `.md` files. The `runAgent()` function loads the prompt, builds system prompt via Handlebars, registers tools, and drives the Vercel AI SDK agentic loop.

**Toolsets** are groups of tools loaded lazily via meta-tools (e.g., `use_vault`). Defined in `src/tools/sets/`.

**Skills** are static `.md` reference documents in `{vault}/Klaus/skills/` with optional YAML frontmatter (`description:` field). Agents that declare `skills:` in frontmatter get a `skill_get` tool scoped to those names via `z.enum`. Skill descriptions are included in the tool description to help the model decide when to load. The `{{skills}}` Handlebars var is injected so agents can list available skills in the prompt. Zero token overhead for agents without skills.

**Notes** are auto-managed, topic-keyed `.md` files in `{vault}/Klaus/notes/`. Unlike snippets (always loaded) or skills (static, on-demand), notes are written and updated by agents at runtime — learned knowledge that is too numerous or low-priority to always inject. The `notes` toolset (`src/tools/sets/notes.ts`) provides four tools: `notes.search` (substring match across filenames, descriptions, body), `notes.write` (create/overwrite with optional frontmatter description), `notes.edit` (find-and-replace within an existing note), `notes.delete` (with confirm guard). Agents opt in by adding `notes` to their `toolsets:` list.

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new context variable = new file implementing `ContextVariable`. Extend by adding, not modifying.

### Storage (src/store/)

All operational data is stored as flat files — no database.

| Module | Format | Purpose |
|--------|--------|---------|
| `conversation.ts` | JSONL (msg/ack/reaction events) | Chat history with in-memory indexes |
| `jsonl.ts` | Date-partitioned JSONL | Generic append/read utilities |
| `costs.ts` | JSONL | Cost tracking by service |
| `invocations.ts` | JSONL | LLM call traces |
| `tasks.ts` | JSON files in status dirs | File-based task queue |
| `files.ts` | JSONL index + blob storage | File metadata |
| `schedules.ts` | JSON + in-memory intervals | Cron schedule persistence |
| `budgets.ts` | JSON | Budget config |

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter is metadata. Vault tools provide search, read, write, and link traversal.

### Key modules

| Path | Concern |
|------|---------|
| `src/types.ts` | All core interfaces (InboundMessage, TurnContext, AgentDefinition, ToolDefinition, ContextVariable) |
| `src/config.ts` | Model tiers, pricing, context budgets, rate limits, timeouts, locale, dataDir |
| `src/core/pipeline.ts` | Message orchestrator |
| `src/core/agent.ts` | Agent executor + agentRegistry |
| `src/core/dispatch.ts` | async/inline/cron dispatch modes |
| `src/core/model-router.ts` | LLM call routing + cost logging |
| `src/core/queue.ts` | In-memory job queue with file-based persistence |
| `src/core/watcher.ts` | File watcher for hot-reloading agent and skill definitions |
| `src/store/` | Flat-file storage modules (conversations, tasks, costs, files, etc.) |
| `src/context/` | Context variable modules (inject dynamic content into prompts) |
| `src/tools/` | Tool definitions + toolset loaders |
| `src/tools/skill.ts` | `buildSkillTool()` — per-agent skill.get tool builder |
| `src/tools/sets/notes.ts` | `notes` toolset: `notes.search`, `notes.write`, `notes.edit`, `notes.delete` — auto-managed knowledge notes |
| `src/tools/conversation.ts` | Standalone tool: search conversation history (text, around message, time range) |
| `src/commands/` | /command handlers |
| `src/whatsapp/` | Transport layer (Baileys connection, send, receive, TTS, STT, presence) |

### Project boundaries

- `/whatsapp` — pure transport, no business logic
- `/core` — pipeline, agent engine, queue, middleware
- `/store` — flat-file storage, JSONL read/write, task queue, indexes
- `/tools` — each tool/tool-set in its own file or folder
- `/context` — one file per context variable
- `{vault}/Klaus/agents/` — markdown prompt files with YAML frontmatter
- `{vault}/Klaus/skills/` — static `.md` reference documents loaded on demand via `skill_get`
- `{vault}/Klaus/notes/` — auto-managed knowledge notes, written/searched by agents at runtime via `notes.*` tools
- `{vault}/Klaus/snippets/` — static prompt content (soul.md, architecture.md) injected as template vars
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
- Config lives in `src/config.ts`, not scattered env reads
- One concern per file
- Path alias `@/` maps to `src/`
- No unnecessary comments — code should be self-explanatory; comments explain *why*, never *what*
- Keep the dependency list short; justify every addition — use `bun add` / `bun update`, no need to check versions manually
