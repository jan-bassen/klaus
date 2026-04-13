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
| Storage      | JSONL flat files (conversations, etc.)        |
| Task queue   | In-memory job queue                           |
| Hosting      | Docker Hub image (`janbassen1/klaus`)             |

---

## Usage

Send a WhatsApp message to the paired number. That's it — Klaus responds using the default agent.

### Agent routing

Prefix your message with `@agent` to route it to a specific agent instead of the default:

- `@think What are the trade-offs between X and Y?` — routes to the thinking agent (large-tier model, extended reasoning)
- `@vault Create a note about today's meeting` — routes to the vault agent (Obsidian read/write)

The default agent can be changed per-chat with the `/default` command.

### Commands

Commands start with `/` and bypass the LLM entirely:

- `/status` — show current agent and active jobs
- `/tasks` — list active background tasks
- `/new` — archive the current conversation and start fresh
- `/default <agent>` — set the default agent for this chat
- `/model [small|medium|large]` — change the model tier of the current default agent
- `/model [claude|chatgpt|gemini]` — switch the active provider for this chat
- `/models` — list all configured providers and their models
- `/register` — register the current chat ID
- `/help [commands|agents|flags|vars|vault]` — show commands, agents, flags, context variables, and vault overview; optional filter narrows to one section

### Flags

Flags start with `!` and can appear anywhere in your message. They are programmatic overrides that control pipeline and agent behavior for the current message:

- `!voice` — guaranteed voice reply (TTS)
- `!clean` — call without conversation history
- `!small` / `!medium` / `!large` — override model tier
- `!claude` / `!chatgpt` / `!gemini` — switch provider for this message
- `!cold` / `!hot` — temperature control (per-provider values)
- `!creative` / `!rigid` — topP control (per-provider values)

Flags are stripped from the message text before it reaches the agent, so they don't interfere with your actual message. Combine freely: `@think !voice !large Explain quantum computing`.

Flags are code-defined in `src/core/flags.ts`. Each flag maps to a typed override applied at the relevant pipeline/agent execution point.

See [REFERENCE.md](REFERENCE.md) for a complete list of all commands, flags, variables, tools, toolsets, modes, and settings.

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

Fill in your `ANTHROPIC_API_KEY` (and optionally `ELEVENLABS_API_KEY` for voice).

3. Start:

```bash
docker run -d --restart unless-stopped \
  --env-file .env \
  -v klaus-config:/app/config \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  -p 3000:3000 \
  janbassen1/klaus:latest
```

4. Pair WhatsApp — on first start, Klaus writes a QR code to `{vault}/Klaus/_login/qr-code.svg`. Open it via Obsidian (syncs to your phone) or directly from the vault directory, then scan it in WhatsApp → Linked Devices → Link a Device. The QR refreshes automatically if it expires.

5. Discover your chat ID — send any message to the paired WhatsApp number. Klaus is in **setup mode** (no `allowedChatId` configured), so it replies with your chat ID and instructions.

6. Add `allowedChatId: "<your-chat-id>"` to `Klaus/settings.yml` in your vault. Klaus hot-reloads settings, so no restart is needed.

After this one-time setup, auth persists in the volume and no further QR scans are needed.

### Self-mode (single number)

If you don't have a second phone number, Klaus can run on your own WhatsApp account. You message yourself ("Note to Self" chat) and Klaus replies in the same chat.

1. Add `selfMode: true` under `whatsapp:` in `Klaus/settings.yml`:

```yaml
whatsapp:
  selfMode: true
```

2. Pair WhatsApp via QR code as above.
3. Send any message to yourself — Klaus auto-detects your JID, completes setup, and replies with a greeting.

In self-mode, all outbound messages are prefixed with `[AgentName]:` (for LLM replies) or `[System]:` (for commands and system messages) so you can distinguish them from your own text.

---

## Deployment (Docker Hub)

Klaus is published as a single image on Docker Hub: `janbassen1/klaus`.

### Pull and run

```bash
docker pull janbassen1/klaus:latest
```

### Publish a new version

One-time setup:

```bash
docker login
docker buildx create --name klaus-builder --driver docker-container --use
```

Then publish:

```bash
bun run publish
```

This builds for `linux/amd64` and pushes both `janbassen1/klaus:<version>` and `:latest`.

### Update

```bash
docker pull janbassen1/klaus:latest && docker restart <container-name>
```

Or use Container Manager > Registry > Download latest in the Synology DSM UI.

### Verify

```bash
curl http://localhost:3000/healthz
# {"status":"ok","ts":"...","whatsapp":"connected","version":"0.1.0"}
```

---

## Operations

Follow logs:

```bash
docker logs -f <container-name>
```

Restart (e.g. after .env edit):

```bash
docker restart <container-name>
```

Deploy update:

```bash
docker pull janbassen1/klaus:latest && docker restart <container-name>
```

Show container status:

```bash
docker ps
```

**Destructive** — wipe all data:

```bash
docker rm -f <container-name> && docker volume rm klaus-config klaus-vault klaus-data
```

---

## Configuration

### .env

API keys and host-specific settings, gitignored, never committed.

| Variable            | Default | Description                             |
| ------------------- | ------- | --------------------------------------- |
| ANTHROPIC_API_KEY   | —       | Claude API key (required)               |
| ELEVENLABS_API_KEY  | —       | ElevenLabs TTS/STT key (required)       |
| ALLOWED_CHAT_ID     | —       | WhatsApp chat ID to allow (fallback — prefer `allowedChatId` in settings.yml) |
| LOG_FORMAT          | `pretty` | Log output: `pretty` or `json`         |
| STARTUP_CONNECTION_WARN_AFTER_MS | `60000` | Warn if WhatsApp connection is still pending after this many ms |
| PORT                | `3000`  | HTTP port for `/healthz`                |
| BAILEYS_AUTH_FOLDER | `<cwd>/.baileys-auth` | WhatsApp auth state directory |
| DATA_DIR            | `~/.klaus/data` | Operational data (conversations, etc.) |
| VAULT_DIR           | `<cwd>/vault` | Vault root (folders configured in `Klaus/settings.yml` with per-folder permissions) |

All path variables default to sensible local values — no extra config needed for local dev.

---

## Architecture

### Message pipeline

Every inbound WhatsApp message flows through the same pipeline:

1. **Auth** — reject if chatId is not in the allowlist (fail-closed)
2. **Rate limit** — per-chat rate limiting; soft reject with retry message
3. **Normalize** — transcribe voice notes (ElevenLabs STT), downscale large images
4. **Parse** — extract /command (execute directly, bypass LLM) or @agent routing prefix
5. **Strip flags** — pull out !flag tokens, resolve programmatic overrides
6. **Persist** — append message to conversation JSONL, resolve quote-reply
7. **Assemble context** — run all context variables in parallel, trim to token budget
8. **Execute agent** — Vercel AI SDK agentic loop with tools, send response via WhatsApp

### Agents

An agent is a .md file in the vault (`Klaus/agents/`) with YAML frontmatter + a Handlebars prompt body. The frontmatter declares which model tier, tools, toolsets, and provider tools the agent uses:

```yaml
---
name: thinking
modelTier: large
tools: [reply, react]
providerTools: [web_search, code_execution]
toolsets: [vault, dispatch, files]
skills: [workout-plan]        # optional — on-demand .md docs from Klaus/skills/
schedule: "0 3 * * *"         # optional — makes it a cron agent
persistent: true              # optional — forces structured nextRun output, auto-reschedules
---
```

Agent and skill files are watched for changes at runtime — edits to prompt text, YAML frontmatter (model tier, tools, toolsets, schedule, etc.), or adding/removing files take effect automatically with no restart needed. Schedule changes are reconciled immediately (old cron removed, new one registered).

**Persistent agents** (`persistent: true`) use structured output to guarantee they always reschedule themselves. After each run, the model must declare `{ nextRun, objective }` — when to run next and what to focus on. The system creates a one-shot timer automatically. If the model call fails, a fallback timer ensures the chain never breaks. Use this for recurring check-ins (fitness coach, language teacher, daily reminders) where the agent dynamically decides its own interval.

Built-in agents:

| Agent      | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| klaus      | Default conversational agent                                         |
| thinking   | High-tier agent for research and extended reasoning                  |
| memorize   | Async agent dispatched to extract facts into memory.md and user.md   |
| vault      | Obsidian vault specialist — read, search, create, and organize notes |

### Tools and toolsets

**Tools** are always-available capabilities (e.g. reply, react, dispatch). **Toolsets** are groups of related tools that are lazy-loaded to save context tokens. Each toolset registers a use\_\<name\> meta-tool; when the model calls it, the actual tools are injected into the next step.

| Toolset  | Tools                                               | Purpose                                |
| -------- | --------------------------------------------------- | -------------------------------------- |
| vault    | read, search, list, write, append, backlinks, etc.  | Vault notes with folder-level permissions |
| dispatch | agent, schedule, timer, list, cancel                | Agent dispatch, cron, one-time timers  |
| files    | upload, download, list, delete                      | File management                        |
**Standalone tools** are opt-in per agent via `tools:` in frontmatter:

| Tool                 | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| conversation         | Search conversation history by text, around a message, or time range    |

Agents can also use **provider tools** — provider-specific capabilities like web_search and code_execution that are injected directly via the Vercel AI SDK. Tools use canonical names in agent frontmatter (e.g. `web_search`) and are automatically resolved to the correct provider-specific implementation based on the active provider. If the active provider doesn't support a requested tool, it's silently skipped.

### Knowledge layer

Klaus has three types of knowledge content, forming a spectrum from always-loaded to agent-managed:

| Type         | Location              | Loading       | Mutability | Purpose                              |
| ------------ | --------------------- | ------------- | ---------- | ------------------------------------ |
| **Snippets** | `Klaus/snippets/`     | Always loaded | Dynamic    | Core prompt content (soul, architecture, user profile) — injected as `{{vars}}`, supports Handlebars conditionals |
| **Skills**   | `Klaus/skills/`       | On demand     | Static     | Reference material loaded via `skill_get` tool when needed |

**Snippets** are `.md` files in `Klaus/snippets/` plus `Klaus/user.md`. They are loaded every turn as template variables (e.g., `{{personality}}`, `{{user}}`, `{{architecture}}`). Always in context — use for core identity and instructions. Snippets support optional YAML frontmatter with a `scope` field (`system` | `user` | `both`, default: `system`). System-scoped snippets are available as `{{var}}` in agent prompts. User-scoped snippets are available as `$var` in WhatsApp messages. `both` makes them available everywhere. Snippet content supports Handlebars templating with turn context vars (`voiceMode`, `acceptMode`, `provider`, `forceVoice`, `suppressVoice`, `autoAccept`, `ghost`, `isVoiceOn`, `isVoiceOff`, `isVoiceAuto`, `isVoiceFixed`), enabling conditional blocks like `{{#if isVoiceOn}}...{{/if}}`. Compiled in a first pass before agent prompt assembly — no recursion risk.

**Skills** are `.md` files in `Klaus/skills/` with optional `description:` frontmatter. Declare `skills: [name1, name2]` in an agent's frontmatter to grant access via a `skill_get` tool scoped to those names via `z.enum`. The `{{skills}}` Handlebars var lists available skills in the prompt. Zero token overhead for agents without skills.

All knowledge files are watched and hot-reloaded.

### Context assembly

Context variables are modular async functions in `src/context/` that provide dynamic content. They run in parallel and support two interpolation syntaxes:

- **System prompts**: Handlebars `{{variable}}` placeholders (full HBS support with helpers)
- **User messages**: `$variable` syntax (mobile-friendly, typed in WhatsApp)

Both syntaxes support params: `{{active_tasks?limit=3}}` or `$active_tasks?limit=3`. Params are passed to the variable's `run()` function at execution time. Unknown `$names` in user messages pass through unchanged.

Each variable has a priority (lower = trimmed first when the token budget overflows) and a truncation strategy (never, always, oldest).

Context variables:

| Variable           | Priority | Params        | Purpose                                                        |
| ------------------ | -------- | ------------- | -------------------------------------------------------------- |
| `snippets`         | -1       | —             | Loads `Klaus/snippets/*.md` + `user.md` as template vars (scope-aware) |
| `date`, `time`, `weekday` | -1 | —           | Current datetime (locale-aware, never trimmed)               |
| `dispatch_context` | -1       | —             | Dispatch metadata when invoked via `dispatch.agent`            |
| `active_tasks`     | 4        | `limit=N`     | Running async jobs and pending timers                          |

### Storage

All operational data is stored as flat files — no database required.

- **Conversations** — JSONL files in `{dataDir}/conversations/`. Four event types: `msg`, `ack` (WhatsApp delivery confirmation), `reaction`, `trace` (LLM tool-call traces). Merged in-memory on read.
- **Invocations** — date-partitioned JSONL in `{dataDir}/invocations/` (LLM call traces)
- **Files** — blob storage in `{filesDir}/` with a JSONL metadata index
- **Schedules** — `{dataDir}/schedules.json`
- **Timers** — `{dataDir}/timers.json` (one-time future execution, restored on restart)

The user's Obsidian vault serves as the knowledge graph — notes are nodes, `[[wikilinks]]` are edges, YAML frontmatter provides metadata and tags.

### Dispatch

The `dispatch` toolset provides five tools for agent-to-agent invocation:

| Tool              | Behavior                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `dispatch.agent`  | Invoke another agent (inline = sync, async = background job)             |
| `dispatch.schedule` | Register a recurring cron schedule (persisted to schedules.json)       |
| `dispatch.timer`  | Schedule a one-time future execution via setTimeout (persisted to timers.json) |
| `dispatch.list`   | List active schedules, timers, and running jobs                          |
| `dispatch.cancel` | Cancel a schedule, timer, or running job by ID                           |

Max chain depth is enforced to prevent infinite recursive dispatch.

---

## Folder structure

```
src/
├── commands/      # /command handlers
├── context/       # Context variable modules (one file per variable)
├── core/          # Pipeline, agent runner, dispatch, queue, model router
├── store/         # Flat-file storage (conversations, schedules, timers, files, etc.)
├── tools/         # Tool definitions and toolsets
│   └── sets/      # Toolset definitions (vault, dispatch, files)
└── whatsapp/      # Transport layer (connection, receive, send, TTS, STT)

{VAULT_DIR}/           # Vault root — folders with per-folder permissions
├── Klaus/             # Internal folder (default: read, request: full)
│   ├── agents/        # Agent prompt files (.md with YAML frontmatter)
│   ├── settings.yml   # User-facing settings (providers, budgets, permissions, etc.)
│   ├── skills/        # Static .md reference documents (loaded on demand)
│   └── snippets/      # Prompt content with optional HBS conditionals (personality.md, communication.md)
├── Leben/             # User content folders — permissions configured in Klaus/settings.yml
├── Projekte/
└── *.md               # Root-level files
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
modelTier: large
tools: [reply, react]
providerTools: [web_search]
toolsets: [vault]
---

You are a research assistant. Answer questions thoroughly using web search.

It is {{weekday}} ({{date}}, {{time}}).

{{personality}}

{{user}}
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

### Add a new context variable

Create a .ts file in src/context/ that exports a ContextVariable. Each variable has a name (used as the {{variable}} in prompts), a priority (lower = trimmed first on token overflow), and a run function that returns content:

```typescript
import type { ContextVariable } from "@/types";

export const myVar: ContextVariable = {
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

Then use `{{my_context}}` in any agent prompt or `$my_context` in WhatsApp messages. Params are supported: `{{my_context?key=value}}` or `$my_context?key=value` — they are passed as the second argument to `run()`.

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
