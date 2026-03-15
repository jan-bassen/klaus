# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (uses 1Password for env secrets)
op run --env-file=.env -- bun run src/index.ts

# Type checking
bun run typecheck

# Tests (unit, excludes DB tests)
bun run test

# Run a single test file
bun test src/__tests__/pipeline.test.ts

# DB tests (requires running Postgres on port 5433)
bun run test:db

# Watch mode
bun run test:watch

# Linting/formatting (Biome)
bunx biome check --write .

# Database
bun run db:push       # Apply schema changes
bun run db:generate   # Generate migrations
bun run db:studio     # Open Drizzle Studio

# Docker
docker compose up -d postgres   # Start Postgres only
docker compose up -d            # Start all services
docker compose logs -f app      # Follow logs
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

Klaus is a headless personal AI agent: WhatsApp messages → TypeScript pipeline → Postgres + LLM → response.

### Stack

Bun, TypeScript (strict), Postgres (Drizzle ORM, pgvector, pgboss), Baileys, Vercel AI SDK. All containerized via Docker Compose.

### Message flow (pipeline.ts)

Every inbound WhatsApp message goes through a 7-step pipeline in `src/core/pipeline.ts`:

1. **Auth** — allowlist check
2. **Rate limit** — message/min guard
3. **Normalize** — voice → text (STT), image downscale
4. **Parse commands** — `/command` handlers bypass LLM
5. **Parse routing** — `@agentName` prefix, `!flags` extraction
6. **Resolve agent** — look up `agentRegistry` or hot-load from `.md` file
7. **Assemble context** — all context queries run in parallel, trimmed to token budget
8. **Execute agent** — `runAgent()` via Vercel AI SDK agentic loop

### Agent system (core/agent.ts)

Agents are defined as `.md` files in `src/agents/` with YAML frontmatter:

```yaml
---
name: agentName
modelTier: default|low|high    # maps to model IDs in config.ts
tools: [reply, send, react]
toolsets: [memory, task]       # expands to use_* meta-tools; tools loaded lazily
providerTools: [web_search]    # Anthropic built-ins
skills: [workout-plan]        # on-demand .md docs from src/skills/
schedule: "0 3 * * *"         # optional cron
vaultScope: "Training"        # optional: restricts all vault tools to this subdirectory
---
Prompt body with {{contextVar}} Handlebars interpolation.
```

`agentRegistry` (Map<name, AgentDefinition>) is populated at startup from all `.md` files. The `runAgent()` function loads the prompt, builds system prompt via Handlebars, registers tools, and drives the Vercel AI SDK agentic loop.

**Toolsets** are groups of tools loaded lazily via meta-tools (e.g., `use_memory`). Defined in `src/tools/sets/`.

**Skills** are static `.md` reference documents in `src/skills/` with optional YAML frontmatter (`description:` field). Agents that declare `skills:` in frontmatter get a `skill_get` tool scoped to those names via `z.enum`. Skill descriptions are included in the tool description to help the model decide when to load. The `{{skills}}` Handlebars var is injected so agents can list available skills in the prompt. Zero token overhead for agents without skills.

**Extension pattern:** new agent = new `.md` file; new tool = new file implementing `ToolDefinition`; new context query = new file implementing `ContextQuery`. Extend by adding, not modifying.

### Knowledge graph (db/schema.ts)

Central data store is a knowledge graph in Postgres:
- **nodes** — typed (episode, procedure, topic, document, project, entity, assertion) with pgvector embeddings (Voyage-4, 1024-dim) and tsvector full-text
- **edges** — typed relationships between nodes
- **chunks** — nodes >800 tokens split for finer-grained embedding search
- **nodeVersions** — edit history with reason codes
- **provenance** — source tracking per node

Search is hybrid: cosine similarity + full-text, with 1-hop edge expansion.

Prefer Postgres-native solutions (pgvector, pgboss, tsvector) over adding new infrastructure.

### Key modules

| Path | Concern |
|------|---------|
| `src/types.ts` | All core interfaces (InboundMessage, TurnContext, AgentDefinition, ToolDefinition, ContextQuery) |
| `src/config.ts` | Model tiers, pricing, context budgets, rate limits, timeouts, locale |
| `src/core/pipeline.ts` | Message orchestrator |
| `src/core/agent.ts` | Agent executor + agentRegistry |
| `src/core/dispatch.ts` | async/inline/cron dispatch modes |
| `src/core/model-router.ts` | LLM call routing + cost logging |
| `src/context/` | Context query modules (inject dynamic content into prompts) |
| `src/tools/` | Tool definitions + toolset loaders |
| `src/tools/skill.ts` | `buildSkillTool()` — per-agent skill.get tool builder |
| `src/skills/` | Static `.md` skill documents (loaded on demand) |
| `src/commands/` | /command handlers |
| `src/whatsapp/` | Transport layer (Baileys connection, send, receive, TTS, STT, presence) |
| `src/db/` | Drizzle schema, client, write path, search |

### Project boundaries

- `/whatsapp` — pure transport, no business logic
- `/core` — pipeline, agent engine, queue, middleware
- `/db` — schema, search, write path, migrations
- `/tools` — each tool/tool-set in its own file or folder
- `/context` — one file per context query
- `/agents` — markdown prompt files with YAML frontmatter
- `/skills` — static `.md` reference documents loaded on demand via `skill_get`

### Testing conventions

- Tests mirror source tree under `src/__tests__/`
- Write tests alongside the code being developed, not after
- Mocks must be registered **before** importing the module under test (Bun mock hoisting)
- Use real Postgres for DB tests (`RUN_DB_TESTS=1`); mock at the model-router boundary for unit tests
- Clean up registries in `afterEach` (agentRegistry, toolRegistry)
- No coverage targets — optimize for confidence in the critical paths: pipeline, middleware, DB read/write, tool execution
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

### Environment

Two env files (see README for full list of vars):
- `.env.config` — non-secret config (DATABASE_URL, ports, directories)
- `.env` — secrets (API keys); loaded via 1Password CLI in dev

Required at startup: `ANTHROPIC_API_KEY`, `ALLOWED_CHAT_ID`.
