# Recipes

Small edits for common Klaus tinkering. Most of these happen in Obsidian and hot-reload.

## Make A New Agent

Create `{vault}/Klaus/agents/research.md`:

```markdown
---
name: research
aliases: [r]
tools: [reply, react, skill]
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
You are a careful research assistant.

Use notes before guessing.
Reply with concise findings and exact file paths when useful.

{{snippets.user}}
{{snippets.vault}}
```

Then message:

```text
@research compare the current project options
@r compare the current project options
```

## Make An Agent The Default

Send:

```text
/default research
```

After that, unprefixed messages go to `research`.

## Add An Alias

Edit the agent frontmatter:

```yaml
aliases: [r, notes]
```

Then use:

```text
@notes summarize the inbox
```

Aliases share the same registry as canonical names. If an alias collides, Klaus skips the colliding alias and logs a warning.

## Add A Snippet

Create `{vault}/Klaus/snippets/writing.md`:

```markdown
Write in short paragraphs.
Prefer concrete nouns.
Avoid decorative structure unless it helps the answer.
```

Use it in an agent prompt:

```handlebars
{{snippets.writing}}
```

Snippets can reference variables and other snippets:

```handlebars
Today is {{time.date}}.
User context:
{{snippets.user}}
```

## Give An Agent Vault Read Access

Edit the agent frontmatter:

```yaml
toolsets: [vault]
vaultAccess:
  - "*:read"
```

`toolsets: [vault]` gives the model access to `load_vault`. `vaultAccess` controls which paths the vault tools may touch.

## Give An Agent Write Access To One Folder

```yaml
toolsets: [vault]
vaultAccess:
  - "*:read"
  - "Projects/Klaus:full"
```

Test with simulation first:

```text
@assistant !simulate clean up Projects/Klaus/Inbox.md
```

Read the report before letting the agent run without `!simulate`.

## Make A Voice-First Agent

Edit frontmatter:

```yaml
voice: on
```

Or update the current default agent from WhatsApp:

```text
/voice on
```

Force a single voice reply:

```text
@assistant !voice explain this in one minute
```

Force text for a single turn:

```text
@assistant !text explain this quietly
```

## Change Model For One Turn

```text
@assistant !large !high think through this migration
@assistant !small summarize this note
@assistant !openai rewrite this message
```

Make it permanent for an agent:

```yaml
provider: openai
modelTier: large
reasoningEffort: high
```

## Add A Skill

Create `{vault}/Klaus/skills/meeting-notes.md`:

```markdown
---
description: Meeting-note format for this vault.
toolsets: [vault]
---

# Meeting Notes

Use this shape:

- Date
- Attendees
- Decisions
- Open questions
- Follow-ups
```

Allow the skill in an agent:

```yaml
tools: [reply, skill]
skills: [meeting-notes]
```

The agent can now call `skill_get` when meeting-note guidance is useful.

## Add A Turn Override

Edit `{vault}/Klaus/overrides.yml`:

```yaml
private:
  aliases: [p]
  description: No history and no persistence
  overrides:
    ghost: true
    skipHistory: true
```

Use it:

```text
@assistant !private help me phrase this
@assistant !p help me phrase this
```

## Make A Daily Agent

Create or edit an agent:

```yaml
persistenceMode: static
persistenceSchedule: "0 8 * * *"
persistencePrompt: "Review active tasks and send a short morning plan."
persistenceOverrides: [voice]
```

The schedule is created from frontmatter. Use `/schedules` to inspect active schedules and timers.

## Make A Self-Rescheduling Agent

Use dynamic persistence:

```yaml
persistenceMode: dynamic
persistenceHint: "Schedule the next run when the user should be nudged again."
```

Put the policy in the prompt body:

```markdown
After helping the user, choose the next follow-up time based on urgency.
For casual reminders, prefer tomorrow morning.
For commitments with a date, follow up before that date.
```

Dynamic agents must successfully schedule their next run after each run.

## Clean Up Context For One Turn

```text
@assistant !clean answer only from this message
```

This skips prior conversation history. Use `!ghost` when you also do not want the turn persisted.

## Debug A Weird Reply

1. Send a narrow reproduction message.
2. Add `!simulate` if tools could write, schedule, or send.
3. Open the newest report under `{vault}/Klaus/reports/` if Markdown reports are enabled.
4. Check the rendered system prompt, user message, variables, history, and tool calls.
5. Fix the smallest prompt, snippet, override, or setting that explains the behavior.
