# Klaus — Brief Reference

Personal AI agent: **WhatsApp → TypeScript → Postgres**. See [PLAN.md](PLAN.md) for full spec.

---

## Stack

| Concern | Choice |
|---------|--------|
| Runtime | Bun |
| LLM | Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) |
| Models | `default` = claude-sonnet-4, `high` = claude-opus-4, `low` = claude-haiku-3 |
| Embeddings | Voyage AI `voyage-3` (1024 dims) via `voyage-ai-provider` |
| Voice STT/TTS | ElevenLabs (`scribe_v1` / `eleven_multilingual_v2`) |
| WhatsApp | `@whiskeysockets/baileys` v6 (stable, not v7 RC) |
| DB | Postgres + Drizzle ORM (`drizzle-orm` + `postgres` driver) |
| Queue | `pg-boss` (Postgres-native, `SKIP LOCKED`) |
| Web search | Anthropic built-in `web_search` tool (no wrapper) |

---

## Turn Pipeline (`pipeline.ts`)

```
1. Auth         checkAllowlist(msg)
2. Rate check   checkMessageRate(msg)
3. Debounce     batch rapid messages
4. Normalize    transcribe voice / analyze image
5. Parse        @agent mention, !flags
6. Route        resolve target agent
7. Assemble     context.assemble(turn)  ← all queries in parallel
8. Execute      agent.run(turn)
9. Hooks        dispatch post-turn hooks async via queue
```

Steps 1–4 = pure functions in `middleware.ts` (no LLM). Async jobs bypass pipeline: `worker.ts` → `agent.ts` directly.

---

## Agents

| Agent | Model | Trigger | Hooks |
|-------|-------|---------|-------|
| `klaus` | default | every message (default) | → memorize-agent post-turn |
| `thinking-agent` | high | `@think` prefix | → memorize-agent post-turn |
| `memorize-agent` | default | post-turn hook (async) | — |
| `reflection-agent` | default | daily cron (async) | — |

Agent = `.md` file in `/src/agents/` with YAML frontmatter (model tier, tools, hooks) + prompt body.

Agents with hooks must: (1) send all user output via `reply` tool, (2) return `AgentReturn` JSON: `{ hooks: { "agent-name": { fire: bool, hint?: string } } }`.

---

## Tools

**Standalone** (always loaded): `reply`

**Surface** (always in context, gateway to full set): `memory.search`, `task.create`

**Tool-sets** (loaded on demand):

| Set | Tools |
|-----|-------|
| `memory` | search *(surface)*, write, read, archive, link, unlink, traverse |
| `task` | create *(surface)*, cancel, list |
| `files` | upload, download, list, delete |
| `ops` | cron, cost-tracking, postgres-query |

Web search/fetch = Anthropic provider built-in, passed directly to model.

---

## Data Model

**Seven node types** (flat enum): `episode`, `procedure`, `topic`, `document`, `project`, `entity`, `assertion`

**Key schema:**
- `nodes` — id, type, title, body, tags[], pinned, archived, embedding (pgvector 1024), searchTsv, tokenCount
- `edges` — sourceId, targetId, relation, weight, note. Unique: (source, target, relation)
- `chunks` — nodeId, ordinal, body, embedding, searchTsv (search optimization, NOT nodes)
- `node_versions` — nodeId, version, title, body, tags[], reason (edit history, NOT nodes)
- `provenance` — nodeId, sourceType, sourceId, sourceRef (multi-origin lineage)
- `messages`, `tasks`, `files`, `llmCosts`, `llmBudgets` — operational tables

**Edge relations:** `about`, `part_of`, `derived_from`, `influenced_by`, `references`, `supersedes`, `related_to`

Direction: source acts on target. `related_to` is bidirectional (one row, both directions queried).

**Single write entrypoint:** `db/write.ts` — handles embed, tsvector, upsert, auto-chunking, auto-versioning.
**Single search entrypoint:** `db/search.ts` — hybrid RRF (pgvector + tsvector), chunks resolve to parent node.

---

## Context Assembly (`assemble.ts`)

Runs all queries in parallel, trims by priority on overflow:

| Query | Variable | Trim strategy |
|-------|----------|---------------|
| `graph-context.ts` | `graph_context` | Pinned: never. Results: drop lowest similarity |
| `conversation.ts` | `conversation` | Oldest first |
| `tasks.ts` | `active_tasks` | Oldest first |
| `tools.ts` | `tool_descriptions` | Sets dropped on overflow; standalone/surface never |
| `flags.ts` | `flag_injections` | Never |

---

## WhatsApp Interface

- **Inbound media** — persisted to files volume + `files` table before processing
- **Routing** — `@agentname` prefix → named agent; bare message → Klaus
- **Commands** — `/command` prefix, executed at transport layer (bypass LLM): `commands.ts`
- **Flags** — `!flag` inline soft control (e.g. `!verbose`, `!concise`), injected as `flag_injections`
- **Dedup** — outbound messages keyed by `(task_id, ordinal)` or `(message_id, ordinal)`
- **Confirmation** — `requiresConfirmation` tools trigger WhatsApp reaction prompt (👍/👎)

---

## Key Conventions

- Errors are values — return, don't throw (except at true system boundaries)
- No barrel files — import from specific module
- One concern per file
- Config as immutable code (`src/config.ts`); prompts hot-reload from `.md` files
- DB roles: `app_rw` for app internals, `app_ro` for `postgres-query` tool
- Tests mirror source under `src/__tests__/`; DB tests use real Postgres (no mocking)
- Evals (LLM behavior) are non-blocking; integration smoke tests run in CI

---

## File Structure

```
src/
  config.ts            model tiers, budgets, rate limits
  types.ts             all core interfaces
  index.ts             bootstrap
  core/
    pipeline.ts        turn orchestrator
    middleware.ts      pure functions (auth, debounce, parse)
    agent.ts           generic agent runner + agentRegistry
    model-router.ts    tier → model + rate check per invocation
    worker.ts          pgboss worker → agent.ts
    rate-limiter.ts    sliding window (message + model rates)
    queue.ts           pgboss dispatch + retries
  db/
    schema.ts          Drizzle schema
    client.ts          db instance
    write.ts           node write path (embed, chunk, version, upsert)
    search.ts          hybrid search (RRF, chunk→node resolution)
    queries/           static named queries
    migrations/        sequential SQL files
  whatsapp/
    connection.ts      Baileys setup, QR, reconnect
    receive.ts         raw → InboundMessage → pipeline
    send.ts            send queue (order, dedup, backoff)
    voice.ts           STT + vision analysis
    tts.ts             text-to-speech
    commands.ts        /command parsing + execution
    flags.ts           !flag definitions + parsing
    confirm.ts         tool confirmation flow
  tools/
    reply.ts           send messages, media, reactions
    memory/            write, read, archive, link, unlink, search, traverse
    task/              create, cancel, list
    files/             upload, download, list, delete
    ops/               cron, cost-tracking, postgres-query
  context/
    assemble.ts        parallel assembly + budget enforcement
    graph-context.ts   pinned + hybrid search + edge expansion
    conversation.ts    last N messages
    tasks.ts           active tasks
    tools.ts           tool descriptions + toolset index
    flags.ts           !flag parsing
  agents/
    klaus.md
    thinking-agent.md
    memorize-agent.md
    reflection-agent.md
```
