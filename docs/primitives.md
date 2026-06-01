# Primitives

`src/primitives/` holds the pluggable pieces: **tools** (model-callable functions), **variables** (Handlebars namespaces), and **commands** (`/slash` handlers). Snippets and skills are vault content that plug into these. This is where most new capability lands.

All three kinds are auto-discovered at startup by scanning their directory and duck-typing the exports. A broken file is logged and skipped, never crashing startup. There is **no hot-reload for primitives** — adding or changing one needs a restart. (Vault content — agents, snippets, skills, templates, settings — does hot-reload.)

## Extension contracts

Drop a file in the right directory, export the right shape, restart. No registration wiring.

**Tool** (`primitives/tools/*.ts`, and `tools/sets/*.ts` for toolsets):

```ts
interface ToolDefinition<TInput extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TInput;                          // Zod schema, serialised to JSON Schema
  execute(input: z.infer<TInput>, context: TurnContext): Promise<unknown>;
  maxResultChars?: number;                       // trace/replay truncation override
  maxArgSnippetChars?: number;
}
```

A file may export a single tool or an array of them. The return value goes back to the model as the tool result; return a clear value (or `{ error }`) it can act on.

**Variable** (`primitives/variables/*.ts`):

```ts
interface Variable {
  key: string;                  // top-level Handlebars namespace
  description?: string;
  after?: boolean;              // run in a second phase, with other vars already resolved
  run(turn): Promise<unknown>;  // returns the namespace's value
}
```

**Command** (`primitives/commands/*.ts`):

```ts
interface Command {
  name: string;
  aliases?: string[];
  params?: { name: string }[];
  description: string;
  execute(msg: InboundMessage, args: string[]): Promise<void>;
}
```

## Tools

Standalone tools (`tools/*.ts`):

| Tool | Input | Behaviour |
| --- | --- | --- |
| `send_message` | `text`, `asVoiceNote?`, `quoteMessageLabel?` | The canonical reply tool. Sends `text` to WhatsApp; `asVoiceNote` routes through TTS; a positive `quoteMessageLabel` quotes a history `ref #n` (`0` is ignored). In a sub-agent run it returns the text to the caller instead of sending. |
| `set_reaction` | `emoji`, `messageLabel?` | React to a message (`""` removes). Label `0`/omitted targets the current message. |
| `search_messages` | `text?`, `aroundMessageId?`, `after?`, `before?`, `limit?`, `contextMessages?` | Search conversation history with optional context windows. |
| `send_image` | `prompt`, `inputFileIds?`, `inputMessageLabel?`, `quoteMessageLabel?` | Generate or edit an image and send it. |
| `math` | `expression`, `scope?` | Evaluate a mathjs expression. |

`read_skill` is not a static tool — it is built per agent from its declared `skills`, with an enum input of just those skill names (see Skills below).

## Toolsets

A toolset is a named group of tools that loads lazily, so an agent's initial context stays lean. Declaring `toolsets: [vault]` exposes a single `load_vault` meta-tool; when the model calls it, the set's real tools activate for the rest of the run. The toolset *name* (not the filename) is what the agent declares and what the meta-tool is named after.

| Toolset | Meta-tool | Members |
| --- | --- | --- |
| `vault` | `load_vault` | `vault_read`, `vault_search`, `vault_list`, `vault_write`, `vault_append`, `vault_patch`, `vault_move`, `vault_delete`, `vault_backlinks`, `vault_links`, `vault_tags`, `vault_outline` |
| `files` | `load_files` | `files_upload`, `files_download`, `files_read`, `files_list`, `files_delete` |
| `agents` | `load_agents` | `run_agent`, `schedule_agent`, `list_agent_runs`, `cancel_agent_run` |

Every vault tool routes through a single permission gate (`gateVaultTool`) that enforces the agent's [vault access](infra.md#vault). `run_agent` runs another agent — inline (returning its reply to the caller) or scheduled for later — and respects the chain-depth limit.

## Server tools

Server tools execute on OpenRouter's side, not in the loop. An agent declares them in `serverTools: [...]` and Klaus appends them verbatim to the request:

| Name | Sent as |
| --- | --- |
| `web_search` | `{ type: "openrouter:web_search" }` |
| `web_fetch` | `{ type: "openrouter:web_fetch" }` |

The loop never sees a client-side call for them; any usage and citations are read back from the model response and shown in reports.

## Variables

Variables produce the unified `{{namespace}}` tree available to agent prompts, snippets, and templates.

| Namespace | Provides |
| --- | --- |
| `time` | `{ date, time, weekday }`, localised to `settings`. |
| `media` | The current message's media: `kind`, and a `doc` / `image` / `voice` / `quoted` subtree. |
| `tasks` | `active` — the agent's pending timers and schedules. |
| `dispatch` | `{ prompt, hasMessage }` for sub-agent runs, else null. |
| `config` | The resolved `TurnConfig`, plus `isVoiceOn` / `isVoiceOff` / `isVoiceAuto`. |
| `schedule` | Frontmatter-schedule metadata when a scheduled run fired, else null. |
| `trigger` | The turn's trigger (`message` / `schedule` / `timer` / `dispatch`). |
| `snippets` | Each compiled snippet, as `{{snippets.<name>}}`. |

In a typed (not voice) user message, `$name` and `$name.sub.path` are also expanded against this namespace as a shorthand — e.g. `$time.date`.

## Snippets

Snippets are `.md` fragments in `{vault}/Klaus/snippets/`. Each is compiled once through Handlebars against the full variable namespace, so a snippet can use `{{time.date}}` and the like. Reference them in prompts as `{{snippets.name}}`. Snippets do **not** expand other snippets. The bundled set (`personality`, `communication`, `user`, `architecture`, `vault`) is composed into the default agents' system prompts.

## Skills

Skills are `.md` reference docs in `{vault}/Klaus/skills/`, loaded on demand rather than always in context. An agent's `skills:` list becomes a `read_skill` tool scoped to exactly those names; calling it returns the skill body. A skill's frontmatter may declare its own `tools`/`toolsets`, which activate when the skill is read — so a skill can pull in the capabilities it needs.

## Commands

Commands are `/slash` handlers that bypass the model entirely; the handler runs and the turn ends. They are auto-discovered from `primitives/commands/`. The full user-facing list is in [usage.md](usage.md#commands). Notes for extenders:

- `/model`, `/provider`, and `/voice` write to the default agent's frontmatter file, so changes persist and hot-reload.
- `/next` arms a single-use prefix (stored in `pipeline/next.ts`) consumed by the next non-command message.
- `/stop` and `/resume` toggle the future-work gate without deleting persisted schedules or timers.

---
---
---
---
---
## [Continue to Infra](infra.md)
