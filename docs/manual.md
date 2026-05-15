# Manual

Klaus is easiest to use when you think in three layers:

- WhatsApp is the interface.
- `{vault}/Klaus/` is the editable control panel.
- `src/` is only for new runtime behavior.

Most tinkering should happen in Obsidian. Edit a file, let sync carry it into the container, then message Klaus again.

## Use Klaus

Unprefixed messages go to the current default agent:

```text
summarize today's open loops
```

Route explicitly with `@agent`:

```text
@assistant what changed in Projects/Klaus?
@dispatch remind me tomorrow morning to pack the charger
```

Aliases work the same way:

```text
@d remind me in 20 minutes to check the oven
```

The bundled default agents are:

| Agent | Alias | Use |
| --- | --- | --- |
| `assistant` | none | Main personal assistant. This is the default first-run agent. |
| `dispatch` | `d` | Helper used for scheduling and delegated runs. |
| `meta` | `m` | Assistant for improving Klaus itself. |

Change the default agent for normal unprefixed messages:

```text
/default assistant
```

## Commands

Commands start with `/` and bypass the LLM. Use them when you want Klaus to do a known runtime action.

```text
/help
/help agents
/default assistant
/model large
/provider openai
/voice auto
/schedules
/break
/retry
```

`/help` is generated from the loaded settings, agents, commands, and overrides, so it is the quickest live inventory.

## Overrides

Overrides are one-turn presets from `{vault}/Klaus/overrides.yml`. Put them anywhere after the optional `@agent` route.

```text
@assistant !large !high compare these two ideas
@assistant !clean answer without conversation history
@assistant !simulate organize the Inbox note
```

Useful bundled overrides:

| Override | Aliases | Effect |
| --- | --- | --- |
| `!voice` | `!v` | Force a voice reply for this turn. |
| `!text` | `!txt` | Force text for this turn. |
| `!clean` | `!cl` | Skip conversation history. |
| `!ghost` | `!g` | Do not persist this turn. |
| `!simulate` | `!sim` | Dry-run external and stateful actions. |
| `!small`, `!medium`, `!large` | `!s`, `!m`, `!l` | Change model tier. |
| `!claude`, `!openai`, `!gemini`, `!qwen`, `!deepseek` | varies | Change provider. |
| `!low`, `!high` | `!lo`, `!hi` | Change reasoning effort. |
| `!no-tools` | `!nt` | Disable tool calls for the turn. |

`!simulate` implies `ghost` and `skipHistory`. It writes reports but does not send real WhatsApp replies or persist real state changes.

## Voice And Media

Voice notes are transcribed before the agent sees the message. Spoken routing is normalized when a transcript starts with a configured trigger plus an agent name, such as "hey assistant, ..." or "assistant, ...".

Agent voice modes live in agent frontmatter:

```yaml
voice: auto
```

| Mode | Meaning |
| --- | --- |
| `auto` | Text by default. The model can request voice through the reply tool when the turn calls for it. |
| `on` | Force voice replies for this agent unless a turn suppresses voice. |
| `off` | Suppress voice replies for this agent unless a turn forces voice. |

Use `/voice on`, `/voice off`, or `/voice auto` to update the current default agent's frontmatter. Use `!voice` and `!text` for one turn.

Images are sent as vision input. Supported documents are parsed to text. Quoted messages can bring their original media into the current turn.

## Customize In Obsidian

These files hot-reload:

| File | Purpose |
| --- | --- |
| `{vault}/Klaus/agents/*.md` | Agent prompts and per-agent settings. |
| `{vault}/Klaus/snippets/*.md` | Reusable prompt fragments. |
| `{vault}/Klaus/skills/*.md` | On-demand reference docs agents can load with `skill_get`. |
| `{vault}/Klaus/overrides.yml` | `!preset` definitions. |
| `{vault}/Klaus/settings.yml` | Strict runtime settings. |
| `{vault}/Klaus/templates/*.md` | Message, report, help, error, and welcome templates. |

Runtime code changes need a restart.

## Agents

An agent is a Markdown file with YAML frontmatter and a Handlebars prompt body.

```markdown
---
name: research
aliases: [r]
tools: [reply, react, skill]
toolsets: [vault, dispatch]
providerTools: [web_search]
skills: [obsidian-markdown]
provider: claude
modelTier: large
voice: auto
temp: default
topP: default
reasoningEffort: high
historyLimit: 20
historyScope: full
showTrace: true
report: true
vaultAccess:
  - "*:read"
  - "Projects:full"
---
You are a careful research assistant.

It is {{time.weekday}} ({{time.date}}, {{time.time}}).

Use the vault when the answer depends on notes.
{{snippets.personality}}
{{snippets.user}}
```

The frontmatter controls routing, model config, tools, history, reports, permissions, and persistence. The body is the system prompt.

## Snippets

Snippets live in `{vault}/Klaus/snippets/*.md`.

Every Markdown file becomes `{{snippets.<filename>}}`:

```text
{vault}/Klaus/snippets/user.md -> {{snippets.user}}
{vault}/Klaus/snippets/vault.md -> {{snippets.vault}}
```

Snippets are compiled as Handlebars templates after the other variables are assembled. They can reference variables such as `{{time.date}}` and other snippets such as `{{snippets.user}}`.

An agent gets snippet text wherever its prompt body places that snippet variable.

## Skills

Skills are simplified single-file Markdown references in `{vault}/Klaus/skills/*.md`.

```markdown
---
description: How to write durable meeting notes in this vault.
toolsets: [vault]
---

# Meeting Notes

Use this structure...
```

Agents list allowed skills in frontmatter:

```yaml
skills: [meeting-notes]
```

During a turn, the model can call `skill_get` to load one of those references. Skills can also grant tools or toolsets after they are loaded.

## Tools

Tools are functions the model can call.

`tools` are visible immediately:

```yaml
tools: [reply, react, conversation, skill, math]
```

`toolsets` are lazy groups. The model first sees `load_vault`, `load_dispatch`, or `load_files`; after loading, the real tools become available on the next step.

```yaml
toolsets: [vault, dispatch, files]
```

`providerTools` are server-side OpenRouter tools. Klaus passes them through to the provider and does not execute them locally.

```yaml
providerTools: [web_search, web_fetch]
```

## Vault Permissions

Vault access is layered:

1. Folder defaults from `settings.yml`
2. Agent `vaultAccess`
3. Per-turn override `vault` entries

Example:

```yaml
vaultAccess:
  - "*:read"
  - "Journal:none"
  - "Projects/Klaus:full"
```

Use the least access that still lets the agent work.

## Persistence And Automation

Klaus has three automation paths:

| Path | Use |
| --- | --- |
| `dispatch` toolset | Let one agent run another agent now, later, or on a schedule. |
| Static persistence | Give an agent a fixed recurring cron prompt. |
| Dynamic persistence | Let an agent decide its next run after each run. |

Static persistence lives in agent frontmatter:

```yaml
persistenceMode: static
persistenceSchedule: "0 8 * * *"
persistencePrompt: "Morning check-in. Review active tasks and reply with the plan."
persistenceOverrides: [voice]
```

Dynamic persistence also lives in frontmatter:

```yaml
persistenceMode: dynamic
persistenceHint: "Schedule the next follow-up based on the user's last commitment."
```

For dynamic persistence, Klaus forces a final `persist` tool call after the main reply. The agent must return the next run time, prompt, and optional overrides. If that fails, the chain breaks visibly instead of silently vanishing.

## Reports

When enabled, each run writes a JSON report under `{dataDir}/logs/<date>/`.

If `reports.vaultMarkdown: true`, Klaus also mirrors a readable report to:

```text
{vault}/Klaus/reports/<date>/
```

Reports show:

- Agent, trigger, model, and overrides
- Variables available to the prompt
- Rendered system prompt, user message, and history
- Tool calls and results
- Simulated actions
- Errors and trace output

When tuning agents, the loop is simple: edit one thing, send one narrow test, use `!simulate` for risky tools, read the report, then tighten.
