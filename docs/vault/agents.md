# Agents

Agents are Markdown files in `{vault}/Klaus/agents/`. They define routing, defaults, prompt bodies, tools, schedules, persistence, and vault access.

Reusable snippets and skills are covered in [prompts.md](prompts.md). Render wrappers such as message and report templates live in [templates.md](templates.md).

Tip: keep agent `# System` prompts as static as possible so providers can reuse prompt caches. Put per-turn values such as current time, active tasks, incoming media, and quoted messages in templates or variables that render into the user message instead.

## Shape

```markdown
---
name: research
aliases: [r]
tools: [reply, react]
toolsets: [vault]
providerTools: [web_search]
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
| `providerTools` | string array | Server-side provider tools, such as `web_search`. |
| `skills` | string array | Skill files this agent may load. Adds `skill_get` automatically. |
| `provider` | string | Provider key from `settings.yml`. |
| `modelTier` | `small`, `medium`, `large` | Model tier for this agent. |
| `voice` | `on`, `auto`, `off` | Voice reply behavior. |
| `temp` | `cold`, `default`, `hot` | Temperature preset. |
| `topP` | `creative`, `default`, `rigid` | Top-p preset. |
| `reasoningEffort` | `low`, `default`, `high` | Reasoning effort preset. |
| `stepLimit` | number | Per-turn model/tool step cap. |
| `historyLimit` | number | Prior history rows to include. |
| `historyScope` | `full`, `agent` | Full chat history or only this agent's rows. |
| `showTrace` | boolean | Show compact tool trace rows in future history. |
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
- `# Message` is the synthetic user message for frontmatter schedules.

Frontmatter schedules expose `{{schedule.id}}`, `{{schedule.pattern}}`, and optional `{{schedule.label}}` while rendering `# Message`.

## Tools

Always-visible tools:

```yaml
tools: [reply, react, conversation, math]
```

Lazy toolsets:

```yaml
toolsets: [vault, dispatch, files]
```

Provider tools:

```yaml
providerTools: [web_search, web_fetch]
```

TypeScript implementations for these primitives are documented in [../codebase/primitives.md](../codebase/primitives.md).

When an agent declares `skills`, Klaus adds the scoped `skill_get` tool automatically.

## Vault Permissions

Vault access is layered:

1. Folder defaults from `settings.yml`
2. Agent `vaultAccess`
3. Per-turn override `vault` entries

Example:

```yaml
toolsets: [vault]
vaultAccess:
  - "*:read"
  - "Journal:none"
  - "Projects/Klaus:full"
```

Use the least access that still lets the agent work. Test risky write access with `!simulate` first:

```text
@assistant !simulate clean up Projects/Klaus/Inbox.md
```

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

For dynamic persistence, Klaus forces a final `persist` tool call after the main reply. The agent returns:

| Field | Meaning |
| --- | --- |
| `nextRun` | ISO datetime or duration like `30m`, `6h`, `2d`. |
| `prompt` | Objective for the next run. |
| `overrides` | Optional override names for the next run. |

`nextRun` is clamped by `settings.persistence.minNextRun` and `settings.persistence.maxNextRun`.
