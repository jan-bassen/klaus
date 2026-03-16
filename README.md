# Klaus

A lean, self-hosted personal AI agent: **WhatsApp → TypeScript → Obsidian Vault**. *Klaus* is a reference to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the legendary pirate who allegedly walked past his crew after being beheaded — because this stack is *headless*. Personal hobby project.

---

## Stack

| Layer        | Tech                                         |
| ------------ | -------------------------------------------- |
| Runtime      | Bun + TypeScript (strict)                    |
| LLM / Vision | Anthropic Claude via Vercel AI SDK           |
| STT / TTS    | ElevenLabs                                   |
| WhatsApp     | Baileys (unofficial WA Web API, multi-device)|
| Knowledge    | Obsidian vault (notes, wikilinks, tags)       |
| Storage      | JSONL flat files (conversations, costs, etc.) |
| Task queue   | In-memory queue + file-based task persistence |
| Vault sync   | Obsidian headless (obsidian-headless)        |
| Hosting      | Synology NAS via Docker Compose              |

---

## Usage

Send a WhatsApp message to the paired number. That's it — Klaus responds using the default agent.

### Agent routing

Prefix your message with `@agent` to route it to a specific agent instead of the default:

- `@think What are the trade-offs between X and Y?` — routes to the thinking agent (high-tier model, extended reasoning)
- `@vault Create a note about today's meeting` — routes to the vault agent (Obsidian read/write)

The default agent can be changed per-chat with the `/default` command.

### Commands

Commands start with `/` and bypass the LLM entirely:

- `/status` — show current agent, active tasks, and vault note count
- `/tasks` — list active background tasks
- `/new` — archive the current conversation and start fresh
- `/default <agent>` — set the default agent for this chat
- `/register` — register the current chat ID
- `/help [commands|agents|flags]` — show available commands, agents, and flags; optional filter narrows to one section

### Flags

Flags start with `!` and can appear anywhere in your message. They modify how Klaus responds:

- `!verbose` / `!concise` — control response length
- `!voice` — reply as a voice note
- `!de` / `!en` — force response language
- `!formal` — use formal tone

Flags are stripped from the message text before it reaches the agent, so they don't interfere with your actual message. Combine freely: `@think !verbose !en Explain quantum computing`.

### Media

Klaus handles more than text:

- **Voice notes** — automatically transcribed via ElevenLabs STT, then processed as text
- **Images** — passed to the model as vision input
- **Documents** — attached and made available to the agent
- **Quote-replies** — the quoted message is included as context

---

## Initial setup

Do this once on any machine (laptop or NAS).

**Prerequisites:** Docker, git, and your API keys ready.

1. Clone the repo:

```bash
git clone <repo-url> && cd klaus
```

2. Create env file:

```bash
cp .env.example .env
```

Fill in your API keys in .env.

3. Start:

```bash
docker compose up -d --remove-orphans
```

4. Scan the WhatsApp QR code (one-time — auth persists in a Docker volume):

```bash
docker compose logs -f app
```

5. (Optional) Set up Obsidian vault sync. Fill in OBSIDIAN_EMAIL, OBSIDIAN_PASSWORD, and OBSIDIAN_VAULT_NAME in .env. The sync service authenticates and configures the vault automatically on first start. Sync is bidirectional and continuous — notes Klaus creates will appear in your Obsidian app.

**NAS-specific:** Set BACKUP_DIR=/volume1/backups/klaus in your .env before starting.

---

## Operations

All commands are standard docker compose. Run from the repo root.

Start all services:

```bash
docker compose up -d --remove-orphans
```

Stop all services:

```bash
docker compose down
```

Follow app logs:

```bash
docker compose logs -f app
```

Restart app (e.g. after .env edit):

```bash
docker compose restart app
```

Deploy update:

```bash
git pull && docker compose build app && docker compose up -d app
```

Run backup:

```bash
docker compose --profile backup run --rm backup
```

Show container status:

```bash
docker compose ps
```

**Destructive** — wipe all data:

```bash
docker compose down -v && docker compose up -d --remove-orphans
```

---

## Configuration

### .env

API keys and host-specific settings, gitignored, never committed.

| Variable            | Description                             |
| ------------------- | --------------------------------------- |
| ANTHROPIC_API_KEY   | Claude API key                          |
| ELEVENLABS_API_KEY  | ElevenLabs TTS/STT key                  |
| ALLOWED_CHAT_ID     | WhatsApp chat ID to allow (fail-closed) |
| OBSIDIAN_VAULT_NAME | Obsidian Sync vault name                |
| BACKUP_DIR          | Where backups are written on the host (default: ./backups) |

Non-secret config (PORT, LOG_FORMAT, BAILEYS_AUTH_FOLDER, path overrides) is set directly in `docker-compose.yml` for Docker. For local dev, all values have sensible defaults in code — no extra env file needed.

---

## Backups

```bash
docker compose --profile backup run --rm backup
```

This runs a one-shot container that:

1. Archives the Baileys auth volume to $BACKUP_DIR/\<YYYY-MM-DD\>/baileys_auth.tar.gz
2. Archives file blobs and data dir
3. Prunes backups older than 7 days

On a Synology NAS, schedule it via **Control Panel → Task Scheduler** with command:

```bash
cd /path/to/klaus && docker compose --profile backup run --rm backup
```

---

## Architecture

### Message pipeline

Every inbound WhatsApp message flows through the same pipeline:

1. **Auth** — reject if chatId is not in the allowlist (fail-closed)
2. **Rate limit** — per-chat rate limiting; soft reject with retry message
3. **Normalize** — transcribe voice notes (ElevenLabs STT), downscale large images
4. **Parse** — extract /command (execute directly, bypass LLM) or @agent routing prefix
5. **Strip flags** — pull out !flag tokens
6. **Persist** — append message to conversation JSONL, resolve quote-reply
7. **Assemble context** — run all context queries in parallel, trim to token budget
8. **Execute agent** — Vercel AI SDK agentic loop with tools, send response via WhatsApp

### Agents

An agent is a .md file in the vault (`Klaus/agents/`) with YAML frontmatter + a Handlebars prompt body. The frontmatter declares which model tier, tools, toolsets, and provider tools the agent uses:

```yaml
---
name: thinking
modelTier: high
tools: [reply, react, dispatch]
providerTools: [web_search, web_fetch, code_execution]
toolsets: [vault, task, ops, files]
skills: [workout-plan]        # optional — on-demand .md docs from Klaus/skills/
schedule: "0 3 * * *"         # optional — makes it a cron agent
---
```

Agent and skill files are watched for changes at runtime — edits to prompt text, YAML frontmatter (model tier, tools, toolsets, schedule, etc.), or adding/removing files take effect automatically with no restart needed. Schedule changes are reconciled immediately (old cron removed, new one registered).

Built-in agents:

| Agent      | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| klaus      | Default conversational agent                                         |
| thinking   | High-tier agent for research and extended reasoning                  |
| memorize   | Async agent dispatched to extract facts into memory.md and user.md   |
| vault      | Obsidian vault specialist — read, search, create, and organize notes |

### Tools and toolsets

**Tools** are always-available capabilities (e.g. reply, react, dispatch). **Toolsets** are groups of related tools that are lazy-loaded to save context tokens. Each toolset registers a use\_\<name\> meta-tool; when the model calls it, the actual tools are injected into the next step.

| Toolset | Tools                                               | Purpose                        |
| ------- | --------------------------------------------------- | ------------------------------ |
| vault   | read, search, list, write, append, backlinks, etc.  | Obsidian vault + memory        |
| task    | dispatch, cancel, list, get                         | Async task management          |
| ops     | cron, cost-tracking                                 | Scheduling and spend monitoring|
| files   | upload, download, list, delete                      | File management                |

**Standalone tools** are opt-in per agent via `tools:` in frontmatter:

| Tool                 | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| conversation         | Search conversation history by text, around a message, or time range    |

Agents can also use **provider tools** — Anthropic built-in capabilities like web_search, web_fetch, and code_execution that are injected directly via the Vercel AI SDK.

### Skills

**Skills** are static `.md` reference documents in `Klaus/skills/` (in the vault) that agents can load on demand via the `skill_get` tool. Unlike context queries (always injected), skills are for stable reference material that shouldn't waste tokens every turn.

Skill files support optional YAML frontmatter with a `description:` field. The description is included in the tool definition so the model knows what each skill contains before deciding to load it.

Declare `skills: [name1, name2]` in an agent's frontmatter. The tool is scoped to those names via `z.enum` — the model literally cannot request a nonexistent skill. The `{{skills}}` Handlebars var is injected so the prompt can list available skills. Agents without `skills:` see nothing — zero token overhead.

### Context assembly

The prompt body uses {{variable}} placeholders filled by **context queries** — modular async functions in src/context/. Each query has a priority number (lower = trimmed first when the token budget overflows) and a truncation strategy (never, always, oldest).

Queries run in parallel. Inline params are supported: {{conversation?limit=20\&excludeCurrent=1}}.

Key context queries: snippets (soul, architecture, user, memory from vault files), conversation (chat history with message refs), datetime, message (current message metadata), active_tasks, flags, dispatch_context.

### Storage

All operational data is stored as flat files — no database required.

- **Conversations** — JSONL files in `{dataDir}/conversations/`. Three event types: `msg`, `ack` (WhatsApp delivery confirmation), `reaction`. Merged in-memory on read.
- **Costs** — date-partitioned JSONL in `{dataDir}/costs/`
- **Invocations** — date-partitioned JSONL in `{dataDir}/invocations/` (LLM call traces)
- **Tasks** — one JSON file per task, organized in status directories (`pending/`, `running/`, `done/`, `failed/`, `cancelled/`)
- **Files** — blob storage in `{filesDir}/` with a JSONL metadata index
- **Schedules** — `{dataDir}/schedules.json`

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter provides metadata and tags.

### Dispatch

Agents can invoke other agents via three modes:

| Mode   | Behavior                                                             |
| ------ | -------------------------------------------------------------------- |
| inline | Runs synchronously in the current process                            |
| async  | Creates a task file, enqueues an in-memory job, returns task ID      |
| cron   | Registers a repeating schedule (persisted to schedules.json)         |

Max chain depth is enforced to prevent infinite recursive dispatch.

---

## Folder structure

```
src/
├── commands/      # /command handlers
├── context/       # Context query modules (one file per query)
├── core/          # Pipeline, agent runner, dispatch, queue, model router
├── store/         # Flat-file storage (conversations, tasks, costs, files, etc.)
├── tools/         # Tool definitions and toolsets
│   └── sets/      # Toolset definitions (vault, task, ops, files)
└── whatsapp/      # Transport layer (connection, receive, send, TTS, STT)

vault/Klaus/       # Klaus's own directory in the Obsidian vault
├── agents/        # Agent prompt files (.md with YAML frontmatter)
├── skills/        # Static .md reference documents (loaded on demand by agents)
├── snippets/      # Static prompt content (soul.md, architecture.md)
├── user.md        # User profile (updated by memorize agent)
└── memory.md      # Working memory, facts, preferences (updated by memorize agent)
```

---

## Extending Klaus

The codebase is designed to be extended by adding files, not modifying existing ones. Each extension point follows a consistent pattern: implement an interface, drop a file in the right folder, and it's picked up automatically.

### Add a new agent

Create a .md file in `vault/Klaus/agents/` with YAML frontmatter and a Handlebars prompt body. The frontmatter declares the agent's model tier, tools, and toolsets. The prompt body uses {{variable}} placeholders that are filled by context queries at runtime.

Example — a minimal agent that can reply and search the web:

```yaml
---
name: research
modelTier: high
tools: [reply, react]
providerTools: [web_search]
toolsets: [vault]
---

You are a research assistant. Answer questions thoroughly using web search.

It is {{weekday}} ({{date}}, {{time}}).

# Conversation

{{conversation?limit=10}}

# Current Message

{{message_text}}
```

No restart needed — agent files are watched and hot-reloaded automatically.

### Add a new tool

Create a .ts file in src/tools/ that exports a ToolDefinition. Define a Zod schema for the input, an execute function, and metadata:

```typescript
import { z } from "zod";
import type { ToolDefinition } from "@/types";

const schema = z.object({
  query: z.string().describe("Search query"),
});

export const myTool: ToolDefinition<typeof schema> = {
  name: "my_tool",
  description: "Does something useful",
  inputSchema: schema,
  execute: async ({ query }, context) => {
    // your logic here
    return { result: "done" };
  },
  kind: "builtin",
  capability: "tool",
};
```

Then reference it by name in an agent's frontmatter tools list.

### Add a new context query

Create a .ts file in src/context/ that exports a ContextQuery. Each query has a name (used as the {{variable}} in prompts), a priority (lower = trimmed first on token overflow), and a run function that returns content:

```typescript
import type { ContextQuery } from "@/types";

export const myQuery: ContextQuery = {
  name: "my_context",
  priority: 50,
  run: async (turn, params) => {
    const content = "some dynamic context";
    return {
      content,
      tokenCount: Math.ceil(content.length / 4),
      truncate: "always",
    };
  },
};
```

Then use {{my_context}} in any agent prompt. Params are supported: {{my_context?key=value}}.

### Add a new command

Create a .ts file in src/commands/ that exports a Command. Commands bypass the LLM and execute directly:

```typescript
import type { Command } from "@/commands";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const myCommand: Command = {
  name: "mycommand",
  description: "Does something directly",
  execute: async (msg: InboundMessage, args: string[]) => {
    enqueueMessage({
      chatId: msg.chatId,
      content: "Command executed.",
      dedupKey: `${msg.id}:mycommand`,
    });
  },
};
```

Invoke it in chat with /mycommand.

### Add a new toolset

Create a .ts file in src/tools/sets/ that exports a group of related ToolDefinitions. The toolset registers a use\_\<name\> meta-tool. When the model calls it, the actual tools are injected into the conversation. This keeps the initial context lean — tools are only loaded when needed.

Reference the toolset by name in an agent's frontmatter toolsets list.

### Add a new skill

Create a `.md` file in `vault/Klaus/skills/`. The filename (without `.md`) is the skill name. Add a `description:` in YAML frontmatter so the model knows what the skill contains:

```markdown
---
description: Weekly training split with progressive overload
---
# Workout Plan

## Monday — Push
- Bench press 4×8
- ...
```

Then add the skill name to an agent's frontmatter:

```yaml
skills: [workout-plan]
```

No restart needed — skill files are watched and hot-reloaded automatically.

---

See AGENT.md for coding guidelines and conventions.
