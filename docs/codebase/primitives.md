# Primitives

`src/primitives/` holds the pluggable pieces of the system: **tools** (model-callable functions), **variables** (Handlebars namespaces), and **commands** (`/slash` handlers). This is where most new capability lands when you extend Klaus in code.

The two vault-authored cousins of these primitives, [snippets](../vault/snippets.md) and [skills](../vault/skills.md), plug into the same machinery but live in your vault and hot-reload. They have their own pages.

All three code primitives are auto-discovered at startup. Klaus scans each directory and duck-types the exports, so a broken file is logged and skipped rather than crashing the boot. There is **no hot-reload for primitives**: adding or changing one needs a restart. (Vault content does hot-reload.)

## Extension contracts

The pattern is the same for all three: drop a file in the right directory, export the right shape, restart. There is no registration wiring to update.

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

A file may export a single tool or an array of them. The return value goes back to the model as the tool result, so return a clear value (or `{ error }`) it can act on.

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
| `send_message` | `text`, `asVoiceNote?`, `quoteMessageLabel?` | Core tool for user-visible WhatsApp replies in message, schedule, and timer runs. `asVoiceNote` routes through TTS; a positive `quoteMessageLabel` quotes a history `ref #n` (`0` is ignored). |
| `return_result` | `text` | Core tool for inline `run_agent` children. Returns `text` to the calling agent and never sends to WhatsApp. |
| `set_reaction` | `emoji`, `messageLabel?` | Core tool for message runs. Reacts to a message (`""` removes the reaction). Label `0`/omitted targets the current message. |
| `search_messages` | `text?`, `aroundMessageId?`, `after?`, `before?`, `limit?`, `contextMessages?` | Search conversation history, with optional context windows around hits. |
| `send_image` | `prompt`, `inputFileIds?`, `inputMessageLabel?`, `quoteMessageLabel?` | Core tool for message, schedule, and timer runs. Generates or edits an image and sends it. |
| `math` | `expression`, `scope?` | Evaluate a mathjs expression. |

Core tools are ignored when listed in agent or skill `tools`; Klaus activates them from the trigger instead. A message run gets `send_message`, `set_reaction`, and `send_image`; a schedule or timer gets `send_message` and `send_image`; an inline dispatch gets only `return_result`.

`read_skill` is not a static tool. It is built per agent from that agent's declared `skills`, with an enum input of just those skill names. See [skills](../vault/skills.md).

## Toolsets

A toolset is a named group of tools that loads lazily, which keeps an agent's initial context lean. Declaring `toolsets: [vault]` exposes a single `load_vault` meta-tool; when the model calls it, the set's real tools activate for the rest of the run. The toolset *name* (not the filename) is what the agent declares and what the meta-tool is named after.

| Toolset | Meta-tool | Members |
| --- | --- | --- |
| `vault` | `load_vault` | `vault_read`, `vault_search`, `vault_list`, `vault_write`, `vault_append`, `vault_patch`, `vault_move`, `vault_delete`, `vault_backlinks`, `vault_links`, `vault_tags`, `vault_outline` |
| `files` | `load_files` | `files_upload`, `files_download`, `files_read`, `files_list`, `files_delete` |
| `agents` | `load_agents` | `run_agent`, `schedule_agent`, `list_agent_runs`, `cancel_agent_run` |

Every vault tool routes through a single permission gate (`gateVaultTool`) that enforces the agent's [vault access](infra.md#vault). `run_agent` runs another agent, either inline (returning its `return_result` text to the caller) or scheduled for later, and respects the chain-depth limit.

## Server tools

Server tools execute on OpenRouter's side rather than in the loop. An agent declares them in `serverTools: [...]` and Klaus appends them verbatim to the request:

| Name | Sent as |
| --- | --- |
| `web_search` | `{ type: "openrouter:web_search" }` |
| `web_fetch` | `{ type: "openrouter:web_fetch" }` |

The loop never sees a client-side call for these. Any usage and citations are read back from the model response and shown in [reports](../vault/reports.md).

## Variables

Variables produce the unified `{{namespace}}` tree available to agent prompts, snippets, and templates.

| Namespace | Provides |
| --- | --- |
| `time` | `{ date, time, weekday }`, localised to `settings`. |
| `media` | The current message's media: `kind`, plus a `doc` / `image` / `voice` / `quoted` subtree. |
| `tasks` | `active`, the agent's pending timers and schedules. |
| `dispatch` | `{ prompt, hasMessage }` for sub-agent runs, otherwise null. |
| `config` | The resolved `TurnConfig`, plus `isVoiceOn` / `isVoiceOff` / `isVoiceAuto`. |
| `schedule` | Frontmatter-schedule metadata when a scheduled run fired, otherwise null. |
| `trigger` | The turn's trigger (`message` / `schedule` / `timer` / `dispatch`). |
| `snippets` | Each compiled snippet, as `{{snippets.<name>}}`. |

In a typed (not voice) user message, `$name` and `$name.sub.path` are also expanded against this namespace as a shorthand, so `$time.date` works inline.

## Commands

Commands are `/slash` handlers that bypass the model entirely. The handler runs and the turn ends, so a command never costs a model call. They are auto-discovered from `primitives/commands/`, and the full user-facing list lives in [usage](../usage.md#commands). A few notes for extenders:

- `/model`, `/provider`, and `/voice` write to the default agent's frontmatter file, so the change persists and hot-reloads.
- `/next` arms a single-use prefix (stored in `pipeline/next.ts`) that the next non-command message consumes.
- `/stop` and `/resume` toggle the future-work gate without deleting any persisted schedule or timer.

---

For these primitives built end to end, see the [examples](../examples/): the [language coach](../examples/language-coach.md) adds a variable, and the [expenses tracker](../examples/expenses-tracker.md) adds a tool and a command.

**Related:** [examples](../examples/) · [snippets](../vault/snippets.md) · [skills](../vault/skills.md) · [agents](../vault/agents.md) · [usage](../usage.md) · [pipeline](pipeline.md)
