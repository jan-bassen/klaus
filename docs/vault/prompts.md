# Prompts

This page covers reusable prompt context: snippets and skills. Agent prompt bodies live in [agents.md](agents.md). Render wrappers for messages, help, errors, and reports live in [templates.md](templates.md).

## Snippets

Snippets live in `{vault}/Klaus/snippets/*.md`. Every Markdown file becomes a `{{snippets.<filename>}}` variable:

```text
{vault}/Klaus/snippets/user.md -> {{snippets.user}}
{vault}/Klaus/snippets/vault.md -> {{snippets.vault}}
```

Use snippets inside an agent prompt:

```handlebars
{{snippets.user}}
{{snippets.vault}}
```

Snippets are compiled as Handlebars templates after the other variables are assembled. They can use normal variables such as `{{config.*}}`, `{{media.*}}`, and `{{time.*}}`, but they do not expand other snippets. Compose multiple snippets in the agent prompt instead:

```handlebars
User context:
{{snippets.user}}

Vault context:
{{snippets.vault}}
```

If a snippet needs to mention its own variable name as documentation, escape the opening mustache:

```handlebars
This content is available as \{{snippets.user}}.
```

Example snippet:

```markdown
Write in short paragraphs.
Prefer concrete nouns.
Avoid decorative structure unless it helps the answer.
```

## Skills

Skills are single-file Markdown references in `{vault}/Klaus/skills/*.md`. Agents can load them on demand with `skill_get`.

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

Allow a skill in agent frontmatter:

```yaml
tools: [reply]
skills: [meeting-notes]
```

The model can now call the automatically generated `skill_get` tool when the skill is useful. Skills can also grant tools or toolsets after they are loaded.

## When To Use Which

| Need | Use |
| --- | --- |
| Stable identity or behavior for one agent | Agent `# System` in [agents.md](agents.md). |
| Reused prompt text across agents | Snippet. |
| Longer reference material loaded only when needed | Skill. |
| Message/report/help/error rendering | Template in [templates.md](templates.md). |

Keep snippets short and frequently useful. Use skills when the content is too long or too situational to include in every turn.

The bundled `communication` snippet teaches voice-capable agents that the
OpenRouter TTS model supports short audio tags such as `[warmly]` when they add
delivery nuance.

For prompt caching, prefer static agent prompts and snippets. Avoid putting changing values like `{{time.*}}`, `{{tasks.*}}`, or current-message media directly into an agent `# System`; those belong in the user-message template or the current turn context.
