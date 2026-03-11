# Klaus

A lean, self-hosted personal AI agent: **WhatsApp → TypeScript → Postgres**. *Klaus* is a reference to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the legendary pirate who allegedly walked past his crew after being beheaded — because this stack is *headless*. Personal hobby project.

---

## Stack


| Layer        | Tech                                          |
| ------------ | --------------------------------------------- |
| Runtime      | Bun + TypeScript (strict)                     |
| LLM / Vision | Anthropic Claude via Vercel AI SDK            |
| Embeddings   | Voyage AI (`voyage-3`, 1024-dim)              |
| STT / TTS    | ElevenLabs (Scribe v1 / Multilingual v2)      |
| WhatsApp     | Baileys (unofficial WA Web API, multi-device) |
| Database     | Postgres + Drizzle ORM + pgvector + tsvector  |
| Job queue    | pg-boss (Postgres-native, `SKIP LOCKED`)      |
| Vault sync   | Obsidian headless (`obsidian-headless`)        |
| Hosting      | Synology NAS via Docker Compose               |


---

## Operations

All commands are standard `docker compose`. Run from the repo root.

| What                             | Command                                                   |
| -------------------------------- | --------------------------------------------------------- |
| Start all services               | `docker compose up -d --remove-orphans`                   |
| Stop all services                | `docker compose down`                                     |
| Follow app logs                  | `docker compose logs -f app`                              |
| Restart app (e.g. after .env edit) | `docker compose restart app`                            |
| Deploy update                    | `git pull && docker compose build app && docker compose up -d app` |
| Run backup                       | `docker compose --profile backup run --rm backup`         |
| Show container status            | `docker compose ps`                                       |
| **Destructive** — wipe all data  | `docker compose down -v && docker compose up -d --remove-orphans` |


---

## Drizzle Studio

A Drizzle Studio instance runs as part of the stack, bound to `127.0.0.1:4983` on the host (not exposed to the network).

**Accessing it remotely (from your Mac):**

```bash
ssh -L 4983:localhost:4983 your-nas
```

Then open `http://localhost:4983` in your browser.

---

## Initial setup

Do this once on any machine (laptop or NAS).

**Prerequisites:** Docker, git, and your API keys ready.

```bash
# 1. Clone the repo
git clone <repo-url> && cd klaus

# 2. Create env files
cp .env.example .env
cp .env.secrets.example .env.secrets   # fill in your 4 API keys

# 3. Start
docker compose up -d --remove-orphans

# 4. Apply database schema
docker compose exec app bun run db:migrate

# 5. Scan the WhatsApp QR code (one-time — auth persists in a Docker volume)
docker compose logs -f app

# 6. (Optional) Set up Obsidian vault sync
# Fill in OBSIDIAN_EMAIL, OBSIDIAN_PASSWORD, and OBSIDIAN_VAULT_NAME in .env.secrets.
# The sync service authenticates and configures the vault automatically on first start.
# Sync is bidirectional and continuous — notes Klaus creates will appear in your Obsidian app.
```

**NAS-specific:** Set `BACKUP_DIR=/volume1/backups/klaus` in your `.env` before starting.

---

## Deploying updates

SSH to the NAS and run:

```bash
git pull && docker compose build app && docker compose up -d app
```

This pulls the latest code, rebuilds the Docker image, and restarts the app.

---

## Configuration

`**.env**` — non-secret config, safe to edit freely:


| Variable              | Description                                            | Default            |
| --------------------- | ------------------------------------------------------ | ------------------ |
| `DATABASE_URL`        | Postgres connection string (localhost for local tools) | see `.env.example` |
| `BAILEYS_AUTH_FOLDER` | Auth state directory                                   | `./.auth`          |
| `PORT`                | Internal app port                                      | `3000`             |
| `BACKUP_DIR`          | Where `./run.sh backup` writes files on the host       | `./backups`        |
| `VAULT_DIR`           | Obsidian vault directory (must match Docker mount)     | `./vault`          |


`**.env.secrets**` — API keys, gitignored, never committed:


| Variable             | Description                             |
| -------------------- | --------------------------------------- |
| `ANTHROPIC_API_KEY`  | Claude API key                          |
| `VOYAGE_API_KEY`     | Voyage AI embedding key                 |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS/STT key                  |
| `ALLOWED_CHAT_ID`    | WhatsApp chat ID to allow (fail-closed) |
| `OBSIDIAN_VAULT_NAME`| Obsidian Sync vault name                |


---

## Backups

`docker compose --profile backup run --rm backup` runs a one-shot container that:

1. Dumps Postgres to `$BACKUP_DIR/<YYYY-MM-DD>/postgres.dump` (custom format)
2. Archives the Baileys auth volume to `$BACKUP_DIR/<YYYY-MM-DD>/baileys_auth.tar.gz`
3. Prunes backups older than 7 days

On a Synology NAS, schedule it via **Control Panel → Task Scheduler** with command `cd /path/to/klaus && docker compose --profile backup run --rm backup`.

---

## Architecture

### Message pipeline

Every inbound WhatsApp message flows through the same pipeline:

1. **Auth** — reject if `chatId` is not in the allowlist (fail-closed)
2. **Rate limit** — per-chat rate limiting; soft reject with retry message
3. **Normalize** — transcribe voice notes (ElevenLabs STT), downscale large images
4. **Parse** — extract `/command` (execute directly, bypass LLM) or `@agent` routing prefix
5. **Strip flags** — pull out `!flag` tokens (`!verbose`, `!concise`, `!voice`, `!de`, `!en`, `!formal`)
6. **Persist** — insert message row, resolve quote-reply FK
7. **Assemble context** — run all context queries in parallel, trim to token budget
8. **Execute agent** — Vercel AI SDK agentic loop with tools, send response via WhatsApp

### Agents

An agent is a `.md` file in `src/agents/` with YAML frontmatter + a Handlebars prompt body. The frontmatter declares which model tier, tools, toolsets, and provider tools the agent uses:

```yaml
---
name: thinking
modelTier: high
tools: [reply, react, dispatch]
providerTools: [web_search, web_fetch, code_execution]
toolsets: [memory, task, ops, files]
schedule: "0 3 * * *"  # optional — makes it a cron agent
---
```

Agent files are hot-loaded on demand — edit a `.md` file and it takes effect on the next message, no restart needed.

**Built-in agents:**


| Agent        | Purpose                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `klaus`      | Default conversational agent                                                   |
| `thinking`   | High-tier agent for research and extended reasoning                            |
| `memorize`   | Async agent dispatched to extract facts into the knowledge graph               |
| `reflection` | Daily cron (03:00 UTC) for graph maintenance: dedup, orphan cleanup, synthesis |
| `vault`      | Obsidian vault specialist — read, search, create, and organize notes           |


### Tools and toolsets

**Tools** are always-available capabilities (e.g. `reply`, `react`, `dispatch`). **Toolsets** are groups of related tools that are lazy-loaded to save context tokens. Each toolset registers a `use_<name>` meta-tool; when the model calls it, the actual tools are injected into the next step.


| Toolset  | Tools                                                | Purpose                         |
| -------- | ---------------------------------------------------- | ------------------------------- |
| `memory` | search, write, read, archive, link, unlink, traverse | Knowledge graph CRUD            |
| `task`   | dispatch, cancel, list                               | Async task management           |
| `ops`    | cron, cost-tracking                                  | Scheduling and spend monitoring |
| `files`  | upload, download                                     | File management                 |
| `vault`  | read, search, list, write, append, backlinks         | Obsidian vault access           |


Agents can also use **provider tools** — Anthropic built-in capabilities like `web_search`, `web_fetch`, and `code_execution` that are injected directly via the Vercel AI SDK.

### Context assembly

The prompt body uses `{{variable}}` placeholders filled by **context queries** — modular async functions in `src/context/`. Each query has a priority number (lower = trimmed first when the token budget overflows) and a truncation strategy (`never`, `always`, `oldest`).

Queries run in parallel. Inline params are supported: `{{conversation?limit=20&excludeCurrent=1}}`.

Key context queries: `conversation` (chat history with message refs), `auto_memory` (pinned nodes + hybrid search), `datetime`, `message` (current message metadata), `active_tasks`, `flags`, `dispatch_context`.

### Knowledge graph

Long-term memory is a typed graph stored in Postgres:

- **Node types:** `episode`, `entity`, `topic`, `assertion`, `procedure`, `project`, `document`
- **Edge relations:** `about`, `part_of`, `derived_from`, `influenced_by`, `references`, `supersedes`, `related_to`
- **Search:** hybrid — pgvector cosine similarity (Voyage AI embeddings) + tsvector full-text, with 1-hop edge expansion on results
- **Pinned nodes** are always included in context, never trimmed. **Archived nodes** are excluded from search.
- **Chunks** split large nodes for finer-grained search. **Node versions** track edit history with reason codes.

The `memorize` agent writes to the graph after conversations. The `reflection` agent runs nightly to merge duplicates, clean orphans, and synthesize higher-order patterns.

### Dispatch

Agents can invoke other agents via three modes:


| Mode     | Behavior                                                              |
| -------- | --------------------------------------------------------------------- |
| `inline` | Runs synchronously in the current process                             |
| `async`  | Creates a task row, enqueues via pg-boss, returns task ID immediately |
| `cron`   | Registers a repeating schedule via pg-boss                            |


Max chain depth is enforced to prevent infinite recursive dispatch.

### Commands and flags

**Commands** (`/status`, `/tasks`, `/register`, `/default`) bypass the LLM entirely — parsed and executed directly by command handlers in `src/commands/`.

**Flags** (`!verbose`, `!concise`, `!voice`, `!de`, `!en`, `!formal`) are inline behavior hints stripped from the message text and injected as highest-priority context that is never truncated.

---

## Folder structure

```
src/
├── agents/        # Agent prompt files (.md with YAML frontmatter)
├── commands/      # /command handlers
├── context/       # Context query modules (one file per query)
├── core/          # Pipeline, agent runner, dispatch, queue, model router
├── db/            # Schema, migrations, search, write path
├── tools/         # Tool definitions and toolsets
│   └── sets/      # Toolset definitions (memory, task, ops, files)
└── whatsapp/      # Transport layer (connection, receive, send, TTS, STT)
```

New agent = new `.md` file in `agents/`. New tool = new file in `tools/`. New context = new file in `context/`. See `AGENT.md` for coding guidelines.

---

## Usage

Send a WhatsApp message to the paired number. Prefix with `@agent` to route to a specific agent (e.g. `@think`). Use `/command` for direct control. Use `!flag` for inline behavior hints (`!verbose`, `!concise`).