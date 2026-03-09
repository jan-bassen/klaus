# Klaus

A lean, self-hosted personal AI agent stack: **WhatsApp → TypeScript → Postgres**. The project is built to be easy configurable and extensible in code, mainly through new tools and agents. *Klaus* is a reference to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the legendary pirate who allegedly walked past his crew after being beheaded — because this stack is *headless*. This is a personal hobby project.

---

## 1. Infrastructure

| **Component**       | **Tech**                           | **Purpose**                                                                                                                  | **Depends on**              |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Hosting             | Synology DS220+ (self-hosted NAS)  | Runs the entire stack via Docker Compose; ARM64, 10 GB RAM                                                                   | —                           |
| CI/CD               | GitHub Actions + self-hosted runner | Runner container on NAS pulls jobs from GitHub — no inbound SSH needed. Agent-only deploys skip Docker rebuild (~5 s)       | Docker                      |
| Backup              | `pg_dump` + volume tar → Hyper Backup | Daily dumps to `/volume1/backups/klaus/`; 7-day retention; Synology Hyper Backup handles off-NAS archival               | Postgres, Docker            |
| Runtime             | Bun                                | JS/TS runtime                                                                                                                | —                           |
| Language            | TypeScript                         | End-to-end type safety                                                                                                       | Bun                         |
| Reverse Proxy       | Caddy                              | Local HTTP reverse proxy (LAN-only; no public exposure needed — Baileys is outbound-only)                                    | —                           |
| WhatsApp Client     | Baileys                            | Unofficial WhatsApp Web API client (multi-device)                                                                            | WhatsApp Web API            |
| Agent Framework     | Vercel AI SDK                      | LLM orchestration + tool calling                                                                                             | —                           |
| AI Providers        | Anthropic · Voyage AI · ElevenLabs | LLM + vision (Claude) · embeddings (Voyage) · TTS + STT (ElevenLabs). Three providers — opinionated defaults, each swappable | Vercel AI SDK               |
| Database            | Postgres + Drizzle ORM             | Core data, knowledge graph, memory — single source of truth                                                                  | Docker                      |
| Job Queue           | pgboss (Postgres)                  | Agent dispatch, retries, stalled recovery, idempotent dedup via `jobId`. Postgres-native via `SKIP LOCKED`                   | Postgres                    |
| Search              | Postgres (pgvector + tsvector)     | Internal hybrid search across nodes and chunks (chunk hits resolved to parent node)                                          | —                           |
| File Storage        | Docker volume + `files` table      | Blobs on volume, metadata in Postgres — `files` table tracks path, type, size, and optional message/node links               | Docker, Postgres            |
| Secrets             | Docker secrets + `.env`            | API keys, tokens, DB credentials                                                                                             | 1Password (source of truth) |
| Health / Monitoring | `/healthz`  • structured JSON logs | Uptime checks, audit trail, debugging                                                                                        | Caddy                       |

---

## 2. WhatsApp Interface

WhatsApp is the **entire UX surface** of Klaus. All user interaction — input, output, control — flows through it.

### Client Library

Baileys connects to the WhatsApp Web API using the multi-device protocol. Runs headless — no phone needed after initial QR pairing. The client connection is managed in `whatsapp/connection.ts` (Baileys setup, QR pairing, reconnect). Inbound messages are normalized in `whatsapp/receive.ts` and handed off to the core pipeline. Outbound delivery — ordering, dedup, rate-limit backoff, retry — lives in `whatsapp/send.ts`. The `/whatsapp` layer is pure transport: no business logic, no routing decisions.

<aside>
<img src="/icons/warning_gray.svg" alt="/icons/warning_gray.svg" width="40px" />

Baileys is an unofficial client, this is a known and accepted failure point

</aside>

### Output & Rich Messaging

- **Multi-message responses** — the agent's reply is split across multiple WhatsApp messages when appropriate (text, code blocks, media, files). A **send queue** handles ordering, rate-limit back-off, and retry
- **Deduplication** — each outgoing message is keyed by `(task_id, message_ordinal)` for task follow-ups, or `(message_id, ordinal)` for direct replies. If the composite key already exists, the send is skipped
- **Image input** — photos and images are analyzed via Claude (`vision` tier). The analysis is included in the target agent's context
- **Voice input** — audio messages are transcribed via ElevenLabs Scribe (`stt` tier). The transcript is passed to the target agent as if it were text
- **Voice output** — voice clips via ElevenLabs (`tts` tier, default `eleven_multilingual_v2`) when requested by the user
- **Media persistence** — all inbound media (images, voice notes, documents) is auto-persisted to the files volume in `receive.ts` before downstream processing. A metadata row is written to the `files` table so every blob is tracked and recoverable regardless of what the pipeline does with its content
- **Reactions** — Klaus reacts to user messages with emoji. Also used for **confirmations** — confirmation-tier security actions prompt the user and Klaus watches for a 👍 reaction to proceed or 👎 to cancel
- **Formatting** — WhatsApp's built-in formatting for rich text: bold, italic, monospace, lists. Long responses are chunked to stay within message size limits or sent via voice

### Routing ( @ )

Agent routes (`@think`, etc.) at the start of a message routes the turn directly to the named agent instead of Klaus (the default). The context assembly pipeline runs identically regardless of which agent handles the turn

### Commands ( / )

**Prefix commands** (`/start`, `/status`, `/abort`, `/switch` etc.) live in `src/commands/`. Parsed from the message text since WhatsApp has no native command system. These provide direct control bypassing the LLM — useful for quick actions and as escape hatches. Command parsing happens in `pipeline.ts` at the parse step (step 4, alongside `@agent` and `!flag` parsing); handlers live in `src/commands/` as business logic separate from the transport layer.

### Flags ( ! )

**Inline `!flags`** in messages give the user soft control over agent behavior without changing the system prompt. Examples: `!verbose`, `!concise`, `!debug`, `!raw`.

Flags are defined in `whatsapp/flags.ts`, parsed from the user message by the `flags.ts` context query, and injected into the prompt as the `flag_injections` variable. The flag map is immutable code — the agent cannot create or modify flag definitions.

### Transport Architecture

The `/whatsapp` layer is split into three focused files — each owns exactly one concern:

| **File**        | **Responsibility**                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.ts` | Baileys setup, QR pairing, reconnect — nothing else                                                                                                                                                                                 |
| `receive.ts`    | Raw message handler → normalize to `InboundMessage` (includes optional `media: { fileId, path, mimeType }` for images, voice notes, documents), auto-persist inbound blobs to files volume + `files` row, hand off to `pipeline.ts` |
| `send.ts`       | Send queue: message ordering, dedup by composite key, WhatsApp rate-limit backoff, retry                                                                                                                                            |

Pre-processing (auth, debounce, rate limiting) is **not** part of the transport layer — it lives in the core pipeline (see *Turn Pipeline*).

---

## 3. Agent Architecture

All agents — including the default conversational agent (Klaus) — share a single pipeline and execution engine. Any agent can run **sync** (inline, blocking) or **async** (via the task layer / pgboss). The system is configured with a **default agent**, **hooks**, and **`@agent`** **routing**.

### Turn Pipeline

Every inbound message flows through **one function**: `pipeline.handleTurn(msg: InboundMessage)` in `core/pipeline.ts`. This is the single orchestrator — it calls utilities from other modules but owns the full sequence. No other file independently handles messages.

```
handleTurn(msg: InboundMessage)
  1. Auth           → middleware.checkAllowlist(msg)
  2. Rate check     → rateLimiter.checkMessageRate(msg)     // message-level gate
  3. Normalize      → [deferred] voice.transcribe / vision.analyzeImage
  4. Parse          → parse @agent, !flags                   // inline in pipeline
  5. Route          → resolve target agent from @mention or default
  6. Assemble       → context.assemble(turn)                 // all context queries, parallel
  7. Execute        → agent.run(turn)                        // sync execution
```

**Key boundaries:**

- **Steps 1–2** are pre-processing (no LLM). `core/middleware.ts` provides pure functions: `checkAllowlist()`. It has no independent message handling — the pipeline calls it
- **Steps 4–5** resolve *what* runs. Routing and flag parsing happen inline in the pipeline
- **Steps 6–7** are the agent turn. `agent.ts` handles assembly and execution, called by the pipeline
- **Async path (tasks)**: `worker.ts` claims pgboss jobs and calls `agent.ts` directly — it does *not* go through `pipeline.ts`. The inbound pipeline is only for user-initiated messages

### Agent Definitions

Every agent is a markdown file in `/src/agents/`. A new agent means adding a prompt template file + deploy. Each agent file contains frontmatter for config (tools, model, …) and the agent instructions. (see *Context*)

**Core default agents:**

| **Agent**                      | **Model** | Context                                      | **Tools**                              | **Default Mode**                                         |
| ------------------------------ | --------- | -------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| **Klaus** *(default)*          | `default` | Active tasks, last messages, related context | Standalone + surface + dynamic loading | sync (entry point)                                       |
| **Thinking Agent**             | `high`    | Active tasks, last messages, related context | Standalone + surface + dynamic loading | sync or async                                            |
| **Memorize Agent**             | `default` | Last messages, deep related context          | `memory.*`                             | async (dispatched by Klaus/thinking via `dispatch` tool) |
| **Reflection Agent** *(daily)* | `default` | Message history, deep related context        | `memory.*`                             | async (scheduled cron)                                   |

### Dispatch System

**`core/dispatch.ts`** is the unified primitive — the only way agents invoke other agents. Three modes:

1. **inline** — run the target agent synchronously in the current process; useful for sub-tasks that need to complete before the caller continues
2. **async** — create a `tasks` row (status: `pending`) and enqueue a pg-boss job; returns the task ID. The worker picks it up and calls `agent.ts` directly
3. **cron** — register a pg-boss schedule for the agent (e.g., reflection at 03:00 UTC daily)

Chain depth is tracked and capped at `config.dispatch.maxChainDepth` (10) to prevent infinite loops.

Agents invoke other agents via the **`dispatch` tool** (surface tool in the `task` toolset). Klaus and thinking use it to trigger memorize after a turn — agent-driven, not pipeline-driven.

### Tool System

**Every tool conforms to a `ToolDefinition` interface** (`types.ts`): `name`, `description`, `inputSchema`, `execute`, plus classification fields — `kind` (`builtin` | `integration`), `capability` (`tool` | `resource`), `requiresConfirmation` and an optional `surface` boolean. The `surface` flag marks a tool-set tool that should always be available, even when its parent set isn't loaded (see *Tool Visibility*). This shape mirrors MCP's `McpServer.tool()` so wrapping any tool as an MCP server later is trivial. Tools can require programmatic user confirmation.

#### Tool Visibility

Three visibility tiers — one definition per tool, no duplication:

| **Tier**       | **Loaded when**                                             | **Examples**                     |
| -------------- | ----------------------------------------------------------- | -------------------------------- |
| **Standalone** | Always — not part of any set                                | `reply`                          |
| **Surface**    | Always — belongs to a set, but promoted to always-available | `memory.search`, `dispatch`      |
| **Set-only**   | Only when the toolset is loaded                             | `memory.write`, `memory.link`, … |

When a toolset loads, its surface tools are already present — no duplication, no swap. The set fills in around them. When the set unloads, surface tools stay. To promote a new tool to always-available, set `surface: true` on its definition — one-line change.

#### Standalone Tools

| **Tool** | **Kind** | **Capability** | **Purpose**                                                       |
| -------- | -------- | -------------- | ----------------------------------------------------------------- |
| `reply`  | builtin  | tool           | Send messages, media, reactions, follow-up questions via WhatsApp |

Basic tools like web search/fetch etc are handled via the providers (Anthropic) built-in tool — passed directly to the model.

#### Tool-Set

Tools are organized into on-demand **namespaced tool-sets** — domain-specific groups that keep the context window lean while enabling richer, more granular tools within each domain. Each available tool set is its own meta-tool for retrieval of the full set. Each tool set has its own folder in /src/tools with an index file for tool set level information. Meta-tool responses are pre-loaded and sticky to minimize latency.

| **Tool-Set** | **Tools**                                                                                                                       | **Purpose**                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **memory**   | `memory.search` *(surface)*, `memory.write`, `memory.read`, `memory.archive`, `memory.link`, `memory.unlink`, `memory.traverse` | Full graph lifecycle — node CRUD, typed edges, hybrid search across nodes and chunks (resolved to parent node) with graph expansion and traversal.          |
| **task**     | `dispatch` *(surface)*, `task.cancel`, `task.list`                                                                              | Agent dispatch + task lifecycle. `dispatch` invokes an agent inline/async/cron. `cancel` marks cancelled + removes pending job. `list` returns active tasks |
| **ops**      | `ops.cron`, `ops.cost-tracking`, `ops.postgres-query`                                                                           | Scheduling, spend/budget queries, read-only named queries via `app_ro`                                                                                      |
| **files**    | `files.upload`, `files.download`, `files.list`, `files.delete`                                                                  | Blob/media CRUD on files volume + `files` metadata table. Optional `nodeId` linking to associate files with graph nodes                                     |

---

## 4. Data & Memory

**Postgres is the single source of truth** — operational data and knowledge graph in one database. The knowledge layer is built on a clean graph primitive: **one `nodes` table, one `edges` table, one toolset.** All memory is a graph.

### Design Principles

1. **Single entrypoints** — `db/write.ts` for writes and `db/search.ts` for hybrid search, no specialized functions around certain types.
2. **Minimal schema, maximal edges** — columns on `nodes` are things *every* node has. Everything else is an edge or lives in `body`.
3. **One node type enum, flat** — no `type` + `kind` hierarchy, no `meta` JSONB. Every node is exactly one thing.
4. **All relations are edges** — no `parent_id`, no implicit hierarchies. If two nodes are related, there's an edge.
5. **Tags stay fast** — `tags[]` column for lightweight labeling. Repeated tags are a signal to create a `topic` node.
6. **No `source` column** — provenance is handled by the dedicated `provenance` table (see below). Typed, queryable, supports multiple origins per node.
7. **Chunks are operational** — chunking is a search optimization, not a node type.
8. **Versioning is operational** — like chunks, version history lives in its own table, not in the graph. `nodes` always holds the current state; `node_versions` stores historical snapshots. `supersedes` edges are reserved for cross-node replacement only.
9. **Files are operational** — like chunks and versions, files are not graph nodes. A lean `files` metadata table tracks blobs on the volume with optional `nodeId` FKs for graph association. No file nodes, no file versioning, no dedup.

### Node Types

One flat enum. Each type represents a distinct *kind of knowledge*, not a structural role.

| **Type**    | **What it is**                                                                        | **Examples**                                                                         |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `episode`   | A record of something that happened — a conversation, an event, an interaction        | A conversation turn summary, a meeting note, "Jan debugged the search bug on Feb 20" |
| `procedure` | A how-to — steps, workflows, routines                                                 | "How to deploy Klaus", morning routine, backup recovery steps                        |
| `topic`     | A concept, theme, or area of interest — the connective tissue of the graph            | "architecture", "postgres", "fitness", "memory-system"                               |
| `document`  | A long-form piece of content — notes, drafts, references, agent-produced artifacts    | A research summary, a design doc snapshot, an article draft, a generated report      |
| `project`   | An ongoing effort with a goal — something you're working toward                       | "Klaus", "Story of Intelligence", "Apartment search"                                 |
| `entity`    | A person, place, organization, or thing — a proper noun in the knowledge graph        | "Dr. Müller", "Hetzner", "Baileys", "Berlin"                                         |
| `assertion` | A discrete, atomic statement — a preference, a belief, a piece of learned information | "Jan prefers German for casual, English for technical", "API rate limit is 60/min"   |

### Schema

#### Enum: `nodeType`

| **Type**    | **Cognitive role**                               | **Why it's its own type**                                                                                                         |
| ----------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `episode`   | Episodic memory — *what happened*                | Temporal, situated; decays and gets summarized over time                                                                          |
| `assertion` | Declarative atom — *what is true/believed*       | Atomic, updateable; enables contradiction detection — same-node corrections versioned, cross-node contradictions use `supersedes` |
| `procedure` | Procedural knowledge — *how to do X*             | Sequential, actionable; can be executed and versioned                                                                             |
| `topic`     | Concept — *connective tissue*                    | Abstract hub node; organizes the graph, tag-promotion target                                                                      |
| `entity`    | Referent — *who/what is X*                       | Proper-noun identity; accumulates edges over time, rarely archived                                                                |
| `project`   | Goal-directed effort — *what I'm working toward* | Like entity but with lifecycle semantics (active → done)                                                                          |
| `document`  | Long-form content — *the "other" bucket*         | Home for content that doesn't reduce to a single assertion or procedure, like an artifact or a report                             |

#### Table: `nodes`

```tsx
export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: nodeType('type').notNull(),
  title: text('title'),
  body: text('body'),
  tags: text('tags').array().default([]),     // fast flat labels, GIN-indexed
  pinned: boolean('pinned').default(false).notNull(),
  archived: boolean('archived').default(false).notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),  // Voyage AI voyage-3
  searchTsv: tsvector('search_tsv'),         // generated on title || body
  tokenCount: integer('token_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

**What's on the table vs. what's not:**

- **No `parent_id`** — all hierarchy expressed via edges.

#### Enum: `edgeRelationType`

| **Relation**    | **Direction** | **Meaning**                      | **Classification heuristic**                                                                                                         |
| --------------- | ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `about`         | A → B         | A's subject matter is B          | "What is A *about*?" — episode about a project, assertion about an entity                                                            |
| `part_of`       | A → B         | A is a child or component of B   | A wouldn't exist independently of B                                                                                                  |
| `derived_from`  | A → B         | A was directly produced from B   | Extraction, summarization, or transformation — A is a *product* of B                                                                 |
| `influenced_by` | A → B         | A’s creation was informed by B   | A was shaped by B but is not a direct product — indirect causal link                                                                 |
| `references`    | A → B         | A explicitly cites or mentions B | An explicit link, citation, or mention — not subject matter, just a pointer                                                          |
| `supersedes`    | A → B         | A replaces B (cross-node)        | A is a *different* node that replaces B. Same-node edits use `node_versions` instead. Trigger: contradiction resolution across nodes |
| `related_to`    | A ↔ B         | Weak, untyped association        | Catch-all — use only when no stronger relation fits. Bidirectional                                                                   |

#### Table: `edges`

```tsx
 export const edges = pgTable('edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  relation: edgeRelationType('relation').notNull(),
  weight: real('weight').default(1.0),   
  note: text('note'),             // optional short text note for future reference
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique().on(t.sourceId, t.targetId, t.relation),
  index('idx_edges_source').on(t.sourceId),
  index('idx_edges_target').on(t.targetId),
  index('idx_edges_relation').on(t.relation),
]);
```

**Directionality contract**: `source` acts on `target`. `related_to` is the exception — treated as bidirectional: only one row is stored per pair, and all queries on `related_to` edges must search both `source_id` and `target_id` directions (i.e. `WHERE (source_id = ? OR target_id = ?) AND relation = 'related_to'`).

#### Table: `chunks`

Chunks are **not nodes**. They're an operational concern — a search optimization that splits long content into embeddable pieces.

```tsx
export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),  // Voyage AI voyage-3
  searchTsv: tsvector('search_tsv'),
  tokenCount: integer('token_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Any node whose `body` exceeds a token threshold gets chunked automatically by the node writer. Chunks are created/destroyed as an implementation detail — search queries both `nodes` and `chunks`, but results are always resolved back to the parent node with the matching chunk highlighted for context. Chunks cascade-delete when their parent node is deleted.

**Tag filtering:** Chunks don't carry their own `tags[]`. Tag-filtered searches JOIN chunks back to their parent node's `tags[]` at query time — no denormalization, no sync overhead.

#### Table: `node_versions`

Versions are **not nodes**. Like chunks, they're an operational concern — an edit-history mechanism that keeps previous states accessible without cluttering the graph.

```tsx
export const nodeVersionReasonType = pgEnum('node_version_reason', [
  'user_edit',              // user explicitly changed the node
  'contradiction_resolved', // memorize resolved a conflict
  'merged',                 // reflection merged duplicates
  'reflection',             // reflection rewrote or refined
]);

export const nodeVersions = pgTable('node_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title'),
  body: text('body'),
  tags: text('tags').array(),
  reason: nodeVersionReasonType('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_node_versions_node').on(t.nodeId),
  unique().on(t.nodeId, t.version),
]);
```

`write.ts` snapshots the current state to `node_versions` before overwriting — same pattern as auto-chunking. `version` is a monotonic integer per node. `reason` tracks *why* the version was created — a user edit, a contradiction resolution by the memorize agent, and a merge by the reflection agent are all distinguishable. Versions cascade-delete when their parent node is deleted.

**Boundary with `supersedes`:** Version history tracks a *single node evolving over time*. The `supersedes` edge is for *cross-node replacement* — when a genuinely new node replaces a different old node (e.g., a new assertion contradicts and replaces an old one). That's a graph-level semantic relationship, not an edit-history concern.

#### Table: `provenance`

Links nodes back to their operational origins — messages, tasks, or external references. This is the bridge between the knowledge graph and operational tables.

```tsx
export const provenanceSourceType = pgEnum('provenance_source_type', [
  'message',        // messages.id
  'task',           // tasks.id
  'external',       // non-table origin — use sourceRef
]);

export const provenance = pgTable('provenance', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  sourceType: provenanceSourceType('source_type').notNull(),
  sourceId: uuid('source_id'),                 // references messages.id, tasks.id, etc. (not a DB-level FK)
  sourceRef: text('source_ref'),               // for 'external' type: URLs, external IDs
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_provenance_node').on(t.nodeId),
  index('idx_provenance_source').on(t.sourceType, t.sourceId),
]);
```

`sourceType` is a Postgres enum — consistent with `nodeType` and `edgeRelationType`. When `sourceType` is `message` or `task`, `sourceId` points at the corresponding table (app-enforced, not a DB-level FK, because it's polymorphic). When `sourceType` is `external`, `sourceRef` holds the origin (URL, external ID, etc.). The composite index on `(source_type, source_id)` makes reverse lookups fast ("which nodes came from this message?").

### Memory Agents

#### Memorize Agent

The memorize agent is a default agent that optionally runs post-turn when the calling agent (usually Klaus). Uses the `memory.*` tool-set to enter new memories to the graph automatically.

**In one pass**, the memorize agent:

1. Uses context and search for assessing if new information has been presented
2. Writes or updates nodes and edges accordingly — updates to existing nodes are automatically versioned by `write.ts` (snapshot before overwrite)
3. Checks for contradictions and issues surrounding the new memories and resolves them if possible. Cross-node contradictions use `supersedes` edges; same-node corrections are versioned updates with reason `contradiction_resolved`

#### Reflection Agent

The reflection agent runs daily via a cron schedule, keeping the graph healthy:

- **General maintenance** — checks new memories (according to schedule) and checks them for issues, inconsistencies, missing pieces, …
- **Tag → topic suggestions** — scans `tags[]` across all nodes, surfaces candidates for `topic` node creation (frequent, semantically coherent tags)
- **Edge decay** — check `related_to` edges for replacement or notifying the user for missing relation type
- **Orphan cleanup** — `topic` nodes with zero edges, or missing `part_of` parents → flag for review
- **Duplicate detection** — semantically similar nodes (embedding distance) → suggest merge. Merges are versioned with reason `merged`
- **Version drift detection** — queries `node_versions` to surface nodes with high churn (e.g., rewritten 4+ times in a week), flags potential instability
- **Pattern synthesis** — reviews recent episodes and current assertions, surfaces higher-order patterns (implicit preferences, recurring themes) as new assertion candidates

### Operational Tables

```tsx
// Messages
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  role: text('role').notNull(),
  content: text('content'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_messages_chat_time').on(t.chatId, t.createdAt),
]);

// LLM Invocation Tracing (replaces lean llmCosts table)
export const agentInvocations = pgTable('agent_invocations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  messageId:        uuid('message_id').references(() => messages.id),
  taskId:           uuid('task_id').references(() => tasks.id),
  agent:            text('agent').notNull(),
  model:            text('model').notNull(),
  systemPrompt:     text('system_prompt'),
  userMessage:      text('user_message'),
  steps:            jsonb('steps').notNull().default(sql`'[]'::jsonb`),
  promptTokens:     integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  costUsd:          numeric('cost_usd', { precision: 10, scale: 6 }),
  durationMs:       integer('duration_ms'),
  createdAt:        timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const llmBudgets = pgTable('llm_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  dailyLimitUsd: numeric('daily_limit_usd', { precision: 10, scale: 2 }),
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 10, scale: 2 }),
  currentDailyUsd: numeric('current_daily_usd', { precision: 10, scale: 6 }).default('0'),
  currentMonthlyUsd: numeric('current_monthly_usd', { precision: 10, scale: 6 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('uq_llm_budgets_chat').on(t.chatId),
]);
// File Metadata
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes'),
  messageId: uuid('message_id').references(() => messages.id),
  nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

### Database Roles

Single `public` schema, fully managed by Drizzle. Migrations are sequential SQL files in git, applied once on deploy.

| **Role** | **Access**              | **Used by**                                          |
| -------- | ----------------------- | ---------------------------------------------------- |
| `app_rw` | DML (read + write rows) | App internals (messages, tasks, nodes, edges, costs) |
| `app_ro` | Read-only               | `postgres-query.ts` tool (read-only named queries)   |

### Scaling Notes

- Personal-agent scale (< 1M rows) → unified `nodes` is fine; partition by `type` if needed
- `ivfflat` works to ~1M vectors → swap to `hnsw` beyond that
- `tags[]` is GIN-indexed → fast filtering across all node types

---

## 5. Tasks

Tasks are how Klaus handles **async work** that goes beyond a single turn — research, content drafting, anything needing background execution with progress tracking.

### State Model

```tsx
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  objective: text('objective').notNull(),
  assignedTo: text('assigned_to'),          // agent name
  caller: text('caller'),                   // who dispatched this task
  status: taskStatusEnum('status').notNull(), // pending | running | done | failed | cancelled
  result: jsonb('result'),                   // whatever the agent produced
  parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
```

**One task = one pgboss job = one agent run.** Klaus creates a task, pgboss dispatches it to the assigned agent, the agent writes its result back when done. Multiple tasks can be active simultaneously — active tasks are loaded on every turn via the `active_tasks` context query so Klaus always knows what's in flight.

### Multi-Step Work

If a task requires multiple steps, the assigned agent handles sequencing internally via `dispatch` tool calls — no upfront DAG declaration needed. This keeps the planning logic in the agent (where it belongs) rather than in a separate orchestration layer.

### Cancellation

`task.cancel` marks the task `cancelled` and removes the pending pgboss job. Already-running jobs finish harmlessly — results from cancelled tasks are ignored.

### Error Handling

**Three-tier escalation:**

1. **Auto-retry** — transient failures retried up to 3× with exponential backoff. Idempotency key (`task_id`) prevents duplicate work
2. **Graceful degradation** — retries exhausted or non-transient failure: mark task `failed`, notify user
3. **Escalate** — critical failure: send WhatsApp message

---

## 6. Context

### Context Queries

Every piece of context injected into a prompt is produced by a **context query** — a typed function that queries data and returns formatted markdown. Each provider maps 1:1 to a `variable` in the prompt template.

```tsx
interface ContextQuery {
  name: string;              // matches the prompt variable
  priority: number;          // lower number = trimmed first on overflow
  run(turn: TurnContext): Promise<ContextResult>;
}

interface ContextResult {
  content: string;
  tokenCount: number;
  truncate: 'never' | 'always' | 'oldest' | 'summarize';
}
```

**Query suite:**

| Query              | **Variable**       | Content                                                                                                        | **Priority** | **Trim**                                 |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| `graph-context.ts` | `graph_context`    | Pinned nodes (always) + hybrid search across nodes and chunks (resolved to parent node) + 1-hop edge expansion | 2            | Truncate oldest                          |
| `conversation.ts`  | `conversation`     | Last N messages from `messages` table                                                                          | 3            | Truncate oldest                          |
| `tasks.ts`         | `active_tasks`     | Active (pending/running) tasks, hierarchical tree                                                              | 4            | Always (removed entirely if over budget) |
| `dispatch.ts`      | `dispatch_context` | Caller, objective, hint, mode — injected for dispatched agents; empty for direct WhatsApp turns                | -1           | Never                                    |
| `datetime.ts`      | `date` / `time`    | Formatted date and time (de-DE, Europe/Berlin timezone)                                                        | static       | Never (no token cost, static snippets)   |

**Flags** (`!flag` tokens) are parsed inline in `pipeline.ts` via `parseFlags()` and stored as `TurnContext.flags`. They are not a context query — `assemble.ts` injects them as static snippets with no token cost.

### Assembly

`core/assemble.ts` runs all context queries in parallel, checks total against `context_budget_tokens` (100k), and trims lowest-priority results first. Each provider's `truncate` controls how it degrades:

- **`never`** — never trimmed
- **`always`** — removed entirely
- **`oldest`** — remove items from the tail (conversations, memories, episodes)
- **`summarize`** — remove full context, but add the summary if it exists

Static snippets (flags, date/time) are injected with no token cost and are never trimmed.

---

## 7. Security

### Auth Gate

`middleware.checkAllowlist()` (called by `pipeline.ts` at step 1) verifies `whatsapp_chat_id` against an allowlist. All messages from unauthorized senders are dropped silently before any further processing.

### Tool Classification

Tools can require confirmation, a call triggers a message automatically that the user can simply react to with 👍/👎. This happens on the code layer and is not the decision of an LLM.

### Rate Limiting

One implementation in `core/rate-limiter.ts`, **two distinct call sites:**

1. **Message-level gate** — called by `pipeline.ts` at step 2 via `rateLimiter.checkMessageRate()`. Prevents message flooding before any LLM work begins
2. **LLM-call-level gate** — called by `model-router.ts` via `rateLimiter.checkModelRate()` before each LLM invocation. Catches runaway tool-calling loops and parallel task storms

---

## 8. Operations

### Configuration Strategy

**Everything is immutable code.** Changes = git push + autodeploy. Agent prompt files in `/src/agents/` support hot-reload: a file watcher detects changes and re-reads the `.md` file without restarting the process.

**Everything is immutable code.** Changes = git push + autodeploy. Agent prompt files in `/src/agents/` support hot-reload: a file watcher detects changes and re-reads the `.md` file without restarting the process.

| **What**                                                        | **Where**          |
| --------------------------------------------------------------- | ------------------ |
| Model tier map, context budgets, rate limits, flags (see below) | `/src/config.ts`   |
| Agent definitions + prompts                                     | `/src/agents/`     |
| Context queries                                                 | `/src/context/`    |
| All tooling                                                     | `/src/tools/`      |
| All commands                                                    | `/src/commands/`   |
| Static queries                                                  | `/src/db/queries/` |

### Model Tier Map

All LLM tiers resolve to Anthropic models. Voice is ElevenLabs. Embeddings are Voyage AI. Changing a provider means updating this map and the corresponding SDK call in `model-router.ts` — nothing else.

```tsx
// config.ts — default model tier map
const models = {
  default: 'claude-sonnet-4-20250514',
  high:    'claude-opus-4-20250514',
  low:     'claude-haiku-3-20250307',
  vision:  'claude-sonnet-4-20250514',
  tts:     'eleven_multilingual_v2',       // ElevenLabs
  stt:     'scribe_v1',                    // ElevenLabs
  embed:   'voyage-3',                     // Voyage AI, 1024 dims
};
```

### Cost Tracking

Token usage and costs tracked automatically at the LLM call layer. Two enforcement levels:

- **Soft limits** — `llmBudgets` daily/monthly USD caps per `whatsapp_chat_id`. On breach: warning message, agent keeps running. `currentDailyUsd` and `currentMonthlyUsd` reset via a pgboss job at midnight UTC/ on the 1st
- **Hard limits** — the sliding-window rate limiter (see *Security → Rate Limiting*). On breach: calls are blocked, async jobs paused and re-enqueued, escalated after 3 consecutive hits

### Backup

**Daily unified snapshot:** `pg_dump` (full `public` schema including pgvector data) + files volume  → Hetzner Storage Box (SFTP/CIFS).

**Retention:** 7 daily + 4 weekly snapshots.

### Monitoring

- `/healthz` endpoint for uptime checks
- Structured JSON logs for audit trail

### Testing

Test runner: **`bun:test`** — zero config, fast, native TypeScript. All tests live in `__tests__/` mirrors of the source tree.

**Three layers, in order of priority:**

#### 1. Deterministic unit tests — the foundation

Everything that *doesn't* touch an LLM should have conventional unit tests. These are fast, reliable, and catch the majority of real bugs.

| **Area**               | **What to test**                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Middleware pipeline    | Allowlist filtering, rate limiter windows, debounce batching, `@agent` / `/command` / `!flag` parsing                                 |
| Context assembly       | Token budget enforcement, priority-based trimming, truncation strategies (`oldest`, `summarize`, `never`)                             |
| DB write path          | `write.ts` — node upsert, auto-chunking at threshold, auto-versioning on update, embedding call, tsvector generation, cascade deletes |
| DB search path         | `search.ts` — RRF fusion ranking, chunk-to-node resolution, tag filtering, edge expansion                                             |
| Tool definitions       | Input validation, schema conformance, error shapes. Test `execute()` with mocked deps                                                 |
| Queue / task lifecycle | pgboss dispatch, retry + backoff logic, cancellation, idempotency via `jobId`                                                         |
| Send queue             | Message ordering, dedup by composite key, rate-limit backoff                                                                          |
| Edge constraints       | Directionality contract (`source` acts on `target`), unique constraint `(source, target, relation)`, `related_to` bidirectionality    |

**DB tests run against a real Postgres instance** (Docker, `testcontainers` or a dedicated test DB) — no mocking the database. Drizzle makes this cheap.

#### 2. Agent evals — testing non-deterministic behavior

LLM outputs aren't deterministic, so traditional assertions don't work. Instead, use **eval-based testing**: run the agent against a curated set of inputs and **judge the outputs programmatically or with an LLM-as-judge.**

**Eval structure:**

```tsx
interface Eval {
  name: string;
  input: string;                    // user message
  context?: Partial<TurnContext>;   // optional injected context (pinned nodes, conversation history)
  assertions: EvalAssertion[];      // what to check
}

interface EvalAssertion {
  type: 'tool_called' | 'tool_not_called' | 'output_matches' | 'llm_judge';
  value: string;                    // tool name, regex, or judge prompt
}
```

**What to eval:**

- **Tool selection** — given an input, did the agent pick the right tool(s)? This is the highest-signal eval. Example: "remember to buy milk" → `memory.write` called, not `reply`
- **Routing** — does `@research` land on the research agent? Does a bare message go to Klaus?
- **Flag injection** — does `!verbose` actually change output length/detail?
- **Memorize-agent judgment** — given a conversation, does it extract the right nodes and edges? Judge: check node types, edge relations, no hallucinated facts
- **Structured output conformance** — when the agent returns structured data (e.g., hook switches), is it schema-valid?
- **Post-turn hook contract** — for agents with hooks: does every turn include at least one `reply` tool call, and is the final return valid structured JSON with the expected hook fields? Catches the "forgot to reply" failure mode

**LLM-as-judge pattern:**

For free-form output quality, use a cheap model (`claude-haiku`) to judge against criteria:

```tsx
async function llmJudge(output: string, criteria: string): Promise<{ pass: boolean; reason: string }>
```

Keep judge prompts short and specific: *"Does the response answer the user's question without hallucinating facts not in the provided context? Yes/No + reason."*

**Eval runs are not CI-blocking** — they run on demand or nightly. Results are logged and tracked over time (store in a `eval_runs` table or plain JSON). The goal is trend detection, not pass/fail gating.

#### 3. Integration smoke tests — the pipeline works end-to-end

A small set of **end-to-end tests** that verify the full turn pipeline without WhatsApp. These use a test harness that simulates an inbound message and captures the outbound response.

```tsx
// Simulates a full turn: message → pipeline → agent → response
async function simulateTurn(input: string, chatId?: string): Promise<TurnResult>
```

**Smoke test suite (~10 tests):**

- A basic message gets a response (happy path)
- An unauthorized `chatId` gets silently dropped
- A `/status` command returns active tasks without an LLM call
- `@think` routes to the thinking agent
- A message with an image triggers vision processing
- Rate limiter kicks in after exceeding the window
- Task creation → pgboss job exists → agent picks it up
- Memorize hook fires post-turn when Klaus signals it

**These run in CI** against a real Postgres instance (same as unit tests). No external API calls — LLM calls are mocked at the `model-router` boundary with canned responses.

#### What's explicitly out of scope

- **No WhatsApp-level E2E tests** — Baileys is an unofficial client; testing against WhatsApp's actual API is fragile and adds no value over the `simulateTurn` harness
- **No snapshot tests for prompts** — prompts change too often in early development. Evals cover output quality instead
- **No coverage targets** — optimize for confidence, not percentages. If the middleware pipeline and DB layer are solid, the rest follows

#### Test file structure

```jsx
/src/__tests__/
  /core
    pipeline.test.ts
    middleware.test.ts
    rate-limiter.test.ts
    queue.test.ts
  /db
    write.test.ts
    search.test.ts
  /whatsapp
    receive.test.ts
    send.test.ts
    flags.test.ts
  /commands
    index.test.ts
  /tools
    memory.test.ts
    task.test.ts
    delegate.test.ts
  /context
    assembly.test.ts
    graph-context.test.ts
  /evals
    tool-selection.eval.ts
    memorize.eval.ts
    routing.eval.ts
  /integration
    turn-pipeline.test.ts
    task-lifecycle.test.ts
```

---

```
Dockerfile
.env.example
/src
  config.ts                  — model tier map, context budgets, rate limits
  types.ts                   — all types
  index.ts                   — bootstrap: load tools/agents/context queries, start queue, register crons, connect WhatsApp, /healthz
  logger.ts                  — structured JSON logging (silent in tests)
  /core
    pipeline.ts              — turn sequence: auth → rate-check → parse → route → assemble → run
    middleware.ts            — pure functions: checkAllowlist()
    agent.ts                 — agent loader (YAML frontmatter) + execution engine (runAgent)
    dispatch.ts              — unified dispatch primitive: inline / async / cron
    model-router.ts          — resolves tier → model; calls generateText(); records agentInvocations
    queue.ts                 — pg-boss wrapper: enqueueJob(), scheduleJob()
    worker.ts                — pg-boss worker: claims jobs, calls agent.ts directly
    rate-limiter.ts          — sliding window; exports checkMessageRate() and checkModelRate()
    assemble.ts              — runs all context queries in parallel, enforces token budget, trims by priority
  /db
    client.ts                — Drizzle + Postgres client
    schema.ts                — Drizzle schema (nodes, edges, chunks + operational tables)
    search.ts                — hybrid search engine (tsvector + pgvector, RRF); chunk hits resolved to parent node
    write.ts                 — node write path: embed, tsvector, upsert, auto-chunk, auto-version
    migrations/              — sequential SQL files
  /whatsapp
    connection.ts            — Baileys setup, QR pairing, reconnect
    receive.ts               — raw message handler → normalize to InboundMessage, hand off to pipeline
    send.ts                  — send queue: ordering, dedup by composite key, rate-limit backoff, retry
    voice.ts                 — [deferred] STT transcription + vision analysis
    tts.ts                   — [deferred] text-to-speech output
    flags.ts                 — !flag definitions + parsing
    confirm.ts               — [deferred] user confirmations for selected tools
  /commands
    index.ts                 — Command interface, CommandRegistry, parseCommand, registry
  /tools
    registry.ts              — tool registry + loading
    reply.ts                 — send messages, media, reactions, follow-up questions
    memory/                  — search (surface), write, read, archive, link, unlink, traverse
    task/                    — dispatch (surface), cancel, list
    files/                   — upload, download, list, delete (blob/media on files volume)
    ops/                     — cron, cost-tracking, postgres-query
  /context
    graph-context.ts         — pinned nodes + hybrid search across nodes and chunks + edge expansion
    conversation.ts          — last N messages from current conversation
    tasks.ts                 — active tasks (pending/running), hierarchical tree
    dispatch.ts              — caller/objective/hint/mode for dispatched agents (empty for direct turns)
    datetime.ts              — date and time (de-DE, Europe/Berlin)
  /agents
    klaus.md
    thinking.md
    memorize.md
    reflection.md
```