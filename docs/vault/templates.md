# Templates

Templates live in `{vault}/Klaus/templates/`. They render the message wrappers, reports, help text, errors, and welcome message.

Prompt content and reusable context live in [agents.md](agents.md) and [prompts.md](prompts.md). Templates are the rendering layer around that content.

## Files

| File | Purpose |
| --- | --- |
| `message-user.md` | Renders inbound user turns before the model sees them. |
| `message-agent.md` | Renders prior agent messages in history. |
| `report.md` | Renders optional Markdown reports into the vault. |
| `help.md` | Renders `/help`. |
| `error.md` | Renders user-facing error messages. |
| `welcome.md` | Renders the first setup-complete message. |

Templates are required. If a required template is missing, execution fails visibly instead of silently falling back.

`message-user.md` is the right place for per-turn context such as current time, active tasks, voice transcripts, attachments, quoted text, and the user's actual message. Keeping that dynamic material out of agent `# System` prompts helps provider prompt caching.

## Variables

Templates use the same Handlebars environment as prompts. Common namespaces include:

| Namespace | Meaning |
| --- | --- |
| `{{time.*}}` | Localized date and time. |
| `{{media.*}}` | Voice, image, document, and attachment context. |
| `{{tasks.*}}` | Active schedules and timers. |
| `{{config.*}}` | Effective agent and turn config facts. |
| `{{dispatch.*}}` | Dispatch trigger prompt and context. |
| `{{schedule.*}}` | Current frontmatter schedule metadata. |
| `{{trigger.*}}` | Message, schedule, timer, or dispatch trigger facts. |
| `{{snippets.*}}` | Compiled snippets from `{vault}/Klaus/snippets/*.md`. |

For the TypeScript side of variables, see [../codebase/primitives.md](../codebase/primitives.md).

## Editing

Templates hot-reload. Edit the file in Obsidian, let sync carry it into the container, then send one narrow test message.

For risky tool turns, use:

```text
@assistant !simulate test this template path
```

Then inspect the report to verify the rendered system prompt, user message, history, and template output.
