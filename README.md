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
| Hosting      | Synology NAS via Docker Compose               |
| CI/CD        | GitHub Actions + self-hosted runner on NAS    |


---

## Running in dev

**Prerequisites:**


| Tool                                                              | Install                                    |
| ----------------------------------------------------------------- | ------------------------------------------ |
| [Bun](https://bun.sh)                                             | `curl -fsSL https://bun.sh/install | bash` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Download + install                         |


```bash
cp .env.secrets.example .env.secrets   # fill in your 4 API keys
docker compose up -d postgres          # start Postgres (override exposes :5432 locally)
bun install
bun run db:migrate                     # apply schema
make dev                               # start the agent — scan QR code on first run
```

To test the full Docker build locally:

```bash
make dev-up    # builds image + starts postgres, app, caddy
make dev-down
```

---

## Deploying to NAS (production)

### One-time setup

**Prerequisites on your Mac:**


| Tool                                          | Install                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| [git](https://git-scm.com)                    | `brew install git` (or Xcode CLT)                                          |
| SSH access to NAS                             | Enable in DSM → Control Panel → Terminal & SNMP                            |
| [gh CLI](https://cli.github.com) *(optional)* | `brew install gh` then `gh auth login` — only needed for runner auto-setup |


**On the NAS**, only Docker is required — Container Manager from the Synology Package Center provides it.

**One-time steps:**

1. Fill in your API keys locally (if not done already):
  ```bash
   cp .env.secrets.example .env.secrets   # then edit with your actual keys
  ```
2. Run the setup script from your Mac (inside this repo):
  ```bash
   make setup-nas NAS=jan@nas
   # or: ./scripts/setup-nas.sh NAS=jan@nas
  ```
   The script will:
  - Clone the repo on the NAS
  - Copy your local `.env` over via SCP
  - Auto-register the GitHub Actions runner (if `gh` is available and logged in)
  - Start all services (postgres, app, caddy, runner)
3. Scan the WhatsApp QR code (printed in the logs output by the script). Auth persists in a Docker volume — this is a one-time step.

### Day-to-day

```bash
make nas-logs      # tail app logs
make nas-restart   # restart app container only (e.g. after manual env changes)
make nas-backup    # dump postgres + baileys_auth to /volume1/backups/klaus
make nas-down      # stop everything
```

### CI/CD (automatic after setup)

Pushes to `main` trigger the self-hosted runner on the NAS:

- **Code changes** → typecheck → tests → Docker rebuild → restart (~2–3 min)
- **Agent-only changes** (`src/agents/`**) → copy `.md` files → restart (~5 s, no rebuild)

---

## Environment variables


| Variable              | Description                                 | Context                          |
| --------------------- | ------------------------------------------- | -------------------------------- |
| `DATABASE_URL`        | Postgres connection string                  | always                           |
| `ANTHROPIC_API_KEY`   | Claude API key                              | always                           |
| `VOYAGE_API_KEY`      | Voyage AI embedding key                     | always                           |
| `ELEVENLABS_API_KEY`  | ElevenLabs TTS/STT key                      | always                           |
| `ALLOWED_CHAT_ID`     | WhatsApp chat ID to allow, fail-closed      | always                           |
| `BAILEYS_AUTH_FOLDER` | Auth state directory (default: `./.auth`)   | always                           |
| `PORT`                | Internal app port — Caddy proxies this      | always                           |
| `DOMAIN`              | Public domain for Caddy TLS (Let's Encrypt) | NAS only                         |
| `GITHUB_REPO_URL`     | Repo URL for self-hosted Actions runner     | NAS only — set by `setup-nas.sh` |
| `GITHUB_RUNNER_TOKEN` | Runner registration token                   | NAS only — set by `setup-nas.sh` |


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


### Tools and toolsets

**Tools** are always-available capabilities (e.g. `reply`, `react`, `dispatch`). **Toolsets** are groups of related tools that are lazy-loaded to save context tokens. Each toolset registers a `use_<name>` meta-tool; when the model calls it, the actual tools are injected into the next step.


| Toolset  | Tools                                                | Purpose                         |
| -------- | ---------------------------------------------------- | ------------------------------- |
| `memory` | search, write, read, archive, link, unlink, traverse | Knowledge graph CRUD            |
| `task`   | dispatch, cancel, list                               | Async task management           |
| `ops`    | cron, cost-tracking                                  | Scheduling and spend monitoring |
| `files`  | upload, download                                     | File management                 |


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