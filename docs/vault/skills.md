# Skills

Skills are `.md` reference docs in `{vault}/Klaus/skills/`. Where a [snippet](snippets.md) is always in the prompt, a skill is loaded on demand: it stays out of context until the agent decides it needs it. That makes skills the right home for detailed, occasionally-needed knowledge that would be wasteful to carry on every turn.

## How an agent uses a skill

An agent's `skills:` list becomes a `read_skill` tool scoped to exactly those names. When the model calls `read_skill` with one of them, Klaus returns that skill's body for the rest of the run.

```yaml
# in an agent's frontmatter
skills: [obsidian-markdown, expense-logging]
```

Because the tool's input is an enum of just the declared names, an agent can only read the skills you have granted it. Listing a skill makes it *available*, not automatically loaded.

## Skill files can pull in capabilities

A skill's own frontmatter may declare `tools` and `toolsets`. When the skill is read, those capabilities activate for the run. This lets a skill bundle both the instructions for a task and the tools that task needs:

```markdown
---
tools: [math]
toolsets: [vault]
---
# Logging an expense

When the user mentions a purchase, append a row to `Finance/expenses.md`
in the format `| {{time.date}} | <amount> | <category> | <note> |`. Use the
`math` tool for any totals.
```

An agent that lists this skill starts lean, and the moment it reads the skill it gains the `vault` toolset and `math` tool alongside the written guidance.

Skills hot-reload, so editing one in Obsidian takes effect on the next turn.

The [knowledge-tree example](../examples/knowledge-tree.md) builds a skill to encode your note-taking conventions and load them on demand.

---

**Related:** [examples](../examples/) · [agents](agents.md) · [snippets](snippets.md) · [primitives](../codebase/primitives.md) · [iteration](../iteration.md)
