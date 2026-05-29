# Agents

Agents are Markdown files in `{vault}/Klaus/agents/`. They define routing, defaults, prompt bodies, tools, schedules, persistence, and vault access.

Reusable snippets and skills are covered in [prompts.md](prompts.md). Render wrappers such as message and report templates live in [templates.md](templates.md).

Tip: keep agent `# System` prompts as static as possible so providers can reuse prompt caches. Put per-turn values such as current time, active tasks, incoming media, and quoted messages in templates or variables that render into the user message instead.

## Bundled Agents

The first-run vault template includes four agents:

| Agent | Alias | Role |
| --- | --- | --- |
| `assistant` |  | General daily driver with messages, vault, files, agent tasks, image, math, and web access. |
| `research` | `r` | Read-oriented investigation agent with web search/fetch, vault/file context, careful synthesis, and no broad vault write permission. |
| `meta` | `m` | Klaus-folder maintainer for agents, skills, snippets, templates, overrides, and settings. |
| `dispatch` | `d` | Generic helper used by `run_agent` for delegated work. |

## Shape

```markdown
---
name: research
aliases: [r]
tools: [send_message, set_reaction]
toolsets: [vault]
serverTools: [web_search]
skills: [obsidian-markdown]
modelTier: large
historyLimit: 20
historyScope: full
vaultAccess:
  - "*:read"
  - "Projects:full"
---
# System

You are a careful research assistant.

Use notes before guessing.
Reply with concise findings and exact file paths when useful.

{{snippets.user}}
{{snippets.vault}}

# Message

Review active tasks and send a short morning plan.
```

Then route messages with the canonical name or alias:

```text
@research compare the current project options
@r compare the current project options
```

Unprefixed messages go to the current default agent. Change it with:

```text
/default research
```

## Frontmatter

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Canonical route name, used as `@name`. Required. |
| `aliases` | string array | Extra route names. Colliding aliases are skipped and logged. |
| `tools` | string array | Always-visible local tools. |
| `toolsets` | string array | Lazy groups exposed through `load_<name>`. |
| `serverTools` | string array | OpenRouter server-side tools, such as `web_search`. |
| `skills` | string array | Skill files this agent may load. Adds `read_skill` automatically. |
| `provider` | string | Provider key from `settings.yml`. |
| `modelTier` | `small`, `medium`, `large` | Model tier for this agent. |
| `voice` | `on`, `auto`, `off` | Voice message behavior. |
| `temp` | `cold`, `default`, `hot` | Temperature preset. |
| `topP` | `creative`, `default`, `rigid` | Top-p preset. |
| `reasoningEffort` | `low`, `default`, `high` | Reasoning effort preset. |
| `stepLimit` | number | Per-turn model/tool step cap. |
| `historyLimit` | number | Prior history rows to include. |
| `historyScope` | `full`, `agent` | Full chat history or only this agent's rows. |
| `showTools` | boolean | Show compact names-only tool summaries on future assistant history rows. |
| `report` | boolean | Emit run reports for this agent. |
| `vaultAccess` | string array | Agent vault permissions as `path:permission`. |
| `persist` | boolean | Enable dynamic self-rescheduling. |
| `persistHint` | string | Required when `persist: true`; policy for choosing the next run. |
| `persistOverrides` | string array | Overrides applied to dynamically created timers. |
| `schedules` | object array | Recurring schedules with `pattern`, optional `label`, optional `overrides`. |

Agent defaults come from `settings.agentDefaults`. One-turn overrides win over both.

## Prompt Sections

Without recognized H1 sections, the whole Markdown body is the system prompt.

With sections:

- `# System` is the stable agent instruction.
- `# Message` is the synthetic user message for frontmatter schedules, timers, and agent-task runs.

Frontmatter schedules expose `{{schedule.id}}`, `{{schedule.pattern}}`, and optional `{{schedule.label}}` while rendering `# Message`.
Timer and agent-task runs expose the requested objective as `{{dispatch.prompt}}`; if an agent has no `# Message` section, Klaus falls back to using that objective directly as the user message.
Inline `run_agent` calls return their `send_message` text to the caller as the tool result. Schedule and timer runs have no caller, so their `send_message` calls send directly to WhatsApp.

## Tools

Always-visible tools:

```yaml
tools: [send_message, set_reaction, search_messages, math]
```

Lazy toolsets:

```yaml
toolsets: [vault, agents, files]
```

Server tools:

```yaml
serverTools: [web_search, web_fetch]
```

TypeScript implementations for these primitives are documented in [../codebase/primitives.md](../codebase/primitives.md).

When an agent declares `skills`, Klaus adds the scoped `read_skill` tool automatically.

## Vault Permissions

Vault access has two layers:

1. `settings.vault.scopes` is the global path allowlist for what Klaus may ever touch.
2. `agentDefaults.vaultAccess`, agent `vaultAccess`, and per-turn override `vault` entries decide permissions inside those scopes.

Access keys are vault-relative paths. Longest path wins, and `"*"` is the
fallback. Agent permissions cannot grant access outside `vault.scopes`.

Example:

```yaml
toolsets: [vault]
vaultAccess:
  - "*:read"
  - "Klaus:none"
  - "Journal:none"
  - "Projects/Klaus:full"
```

Use the least access that still lets the agent work.

## Schedules And Persistence

Recurring schedules live in frontmatter:

```yaml
schedules:
  - pattern: "0 8 * * *"
    label: morning
    overrides: [voice]
```

Dynamic persistence lets an agent decide its next run after each run:

```yaml
persist: true
persistHint: "Schedule the next follow-up based on the user's last commitment."
persistOverrides: [voice]
```

For dynamic persistence, Klaus forces a final `persist` tool call after the main message. The agent returns:

| Field | Meaning |
| --- | --- |
| `nextRun` | ISO datetime or duration like `30m`, `6h`, `2d`. |
| `prompt` | Objective for the next run. |
| `overrides` | Optional override names for the next run. |

`nextRun` is clamped by `settings.persistence.minNextRun` and `settings.persistence.maxNextRun`, which are compact durations such as `1m` and `7d`. If the model returns an unparseable value, Klaus falls back to `settings.persistence.defaultNextRun`.

Frontmatter schedules, `schedule_agent` schedules, and persistence timers all run in the single configured chat. They do not store their own chat target; Klaus resolves `settings.allowedChat` when the run fires.

At startup, Klaus registers schedules before WhatsApp setup may be complete, but keeps schedule and timer clocks paused until the configured chat exists and WhatsApp is connected. Clocks pause again during WhatsApp reconnects. Repeated checks in the same wait state are logged only once.
