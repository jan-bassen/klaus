# Iterate In Obsidian

Most Klaus customization happens in the vault, not the TypeScript code. Edit a file in `{vault}/Klaus/`, let Obsidian Sync carry it into the container, and message Klaus again.

## What Hot-Reloads

- `agents/*.md`
- `skills/*.md`
- `snippets/*.md`
- `templates/*.md`
- `overrides.yml`
- `settings.yml`

Code primitives need a container restart. Vault primitives do not.

## Agents

Agents are Markdown files in `{vault}/Klaus/agents/` with YAML frontmatter and a Handlebars prompt body.

```yaml
---
name: research
aliases: [r]
tools: [reply, react]
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

Today is {{time.date}}.

Use the vault when the answer depends on my notes.
{{snippets.personality}}
{{snippets.user}}
```

Use `@research ...` to route a message to that agent. Use `/default research` to make it the chat default.

`tools` are always-visible local functions. `toolsets` are lazy groups: the agent sees `load_vault`, `load_dispatch`, and similar loader tools first, then receives the full group only after choosing to load it. This is useful for broad capabilities that would otherwise crowd every model call, while still letting an agent read/write the vault, dispatch work, or manage stored files when the turn calls for it.

## Snippets

Snippets live in `{vault}/Klaus/snippets/*.md` and are exposed under `{{snippets.<name>}}`.

Good snippet candidates:

- Stable personal preferences
- Writing style
- Project context
- Reusable tool rules
- Domain-specific vocabulary

Keep snippets composable. Agents should decide which ones they include.

## Skills

Skills live in `{vault}/Klaus/skills/*.md`. Klaus intentionally uses a simplified single-file skill format: one Markdown file per skill, named by filename. It does not implement the broader folder-based skill standard with `SKILL.md` and bundled assets.

Give each skill a short frontmatter description so the `skill_get` tool can present it clearly. A skill can also declare tools or toolsets that become available after the agent loads it.

```markdown
---
description: How to write durable meeting notes in this vault.
toolsets: [vault]
---

# Meeting Notes

Use this structure...
```

Reference skills from an agent:

```yaml
skills: [meeting-notes]
```

The agent can then load the skill on demand during a turn.

## Overrides

Overrides live in `{vault}/Klaus/overrides.yml`. They are per-turn presets activated with `!name` in a message.

```yaml
deep:
  aliases: [d]
  description: Use the large model with high reasoning.
  overrides:
    modelTier: large
    reasoningEffort: high

private:
  aliases: [p]
  description: Do not persist this turn.
  overrides:
    ghost: true
    skipHistory: true
```

Use them anywhere:

```text
@research !deep compare these options
@assistant !private help me phrase this
```

`!simulate` is especially useful while tuning agents with write-capable tools. External and stateful actions are faked or handled through the simulation overlay, and the turn is not persisted.

## Settings

Settings live in `{vault}/Klaus/settings.yml`. This file must match the strict schema in `src/infra/config.ts`; Klaus validates it but does not fill missing fields.

Common fields to tune:

- `basics.allowedChat`
- `basics.locale`
- `basics.timezone`
- `agent.defaultAgent`
- `agent.maxSteps`
- `defaultProvider`
- `providers`
- `media.voice`
- `media.image`
- `whatsapp.selfMode`
- `vault.folders`
- `reports.vaultMarkdown`

The repo `vault/settings.yml` is only the first-run template. After `{vault}/Klaus/` exists, your synced settings file is the source of truth.

## Vault Permissions

Vault access is layered:

1. Folder defaults in `settings.yml`
2. Agent `vaultAccess`
3. Per-turn overrides

Example agent access:

```yaml
vaultAccess:
  - "*:read"
  - "Journal:none"
  - "Projects/Klaus:full"
```

Use the least access that still lets the agent work. The vault tools gate paths against this map before reading or writing.

## Templates

Templates live in `{vault}/Klaus/templates/`. They shape user messages, agent messages, help output, reports, errors, and welcome/setup text.

Templates are required. If a required template is missing, the run fails instead of silently falling back.

## Reports

When reporting is enabled, Klaus writes one JSON report per run under `{dataDir}/logs/`. If `reports.vaultMarkdown` is true, it also mirrors readable Markdown into `{vault}/Klaus/reports/`.

Reports are the quickest way to debug:

- Which agent ran
- Which overrides applied
- Which variables were present
- What system and user prompts were sent
- Which tool calls happened
- Whether simulation intercepted actions

## A Good Iteration Loop

1. Change one agent, snippet, skill, override, or setting.
2. Send a narrow test message.
3. Use `!simulate` if tools could write or send.
4. Read the report.
5. Tighten the prompt or config.
6. Repeat until the behavior is boringly predictable.
