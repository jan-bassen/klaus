# Snippets

Snippets are reusable `.md` fragments in `{vault}/Klaus/snippets/`. They are how you keep a single voice or a shared block of context in one place instead of pasting it into every agent.

Each snippet is compiled once through Handlebars against the full [variable namespace](../codebase/primitives.md#variables), so a snippet can use `{{time.date}}` and the like. You reference one in a prompt as `{{snippets.<name>}}`, where `<name>` is the filename without its extension.

```markdown
You are warm, concise, and a little dry. You never over-explain, and you
ask before doing anything irreversible.
```

```markdown
<!-- in an agent's # System body -->
{{snippets.personality}}
{{snippets.user}}

Today is {{time.weekday}}, {{time.date}}.
```

One rule worth knowing: snippets do **not** expand other snippets. A `{{snippets.x}}` reference inside a snippet file is left as-is. Compose snippets at the agent level, not inside each other.

## Author notes

HTML comments are for humans and are stripped before the snippet reaches the model:

```markdown
<!-- Edit this when Klaus gets your tone wrong. -->
You are warm, concise, and a little dry.
```

Use visible prose only for instructions the model should actually receive. A default snippet may still contain a small visible placeholder on purpose — for example `user.md` can remind the agent that the user has not personalized it yet.

The first-run template ships a small set (`personality`, `communication`, `user`, `architecture`, `vault`) that the default agents compose into their system prompts. Treat them as a starting point: edit `user.md` to tell Klaus who you are, adjust `communication.md` to change its tone, and add your own snippets for anything you find yourself repeating.

Snippets hot-reload, so a save in Obsidian takes effect on the next turn.

---

**Related:** [agents](agents.md) · [skills](skills.md) · [templates](templates.md) · [primitives](../codebase/primitives.md#variables)
