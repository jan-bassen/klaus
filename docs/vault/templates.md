# Templates

Templates live in `{vault}/Klaus/templates/`. They render the message wrappers, persistence prompt, reports, help text, errors, and welcome message.

Prompt content and reusable context live in [agents.md](agents.md) and [prompts.md](prompts.md). Templates are the rendering layer around that content.

## Files

| File | Purpose |
| --- | --- |
| `message-user.md` | Renders inbound user turns before the model sees them. |
| `message-agent.md` | Renders outbound agent replies before they are sent. |
| `history-user.md` | Renders prior user messages for model history replay. |
| `history-agent.md` | Renders prior assistant messages for model history replay. |
| `persistence.md` | Renders the forced follow-up instruction for persistent agents. |
| `report.md` | Renders optional Markdown reports into the vault. |
| `help.md` | Renders `/help`. |
| `error.md` | Renders user-facing error messages. |
| `welcome.md` | Renders the first setup-complete message. |

Templates are required. If a required template is missing, execution fails visibly instead of silently falling back.

`message-user.md` is the right place for live per-turn context such as active tasks, voice transcripts, attachments, quoted text, and the user's actual message. `history-user.md` and `history-agent.md` intentionally avoid live context so replayed chat turns do not duplicate stale state. Keeping dynamic material out of agent `# System` prompts helps provider prompt caching.

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

The shared helper `{{codeFence value}}` wraps report/debug text in a Markdown fence that is longer than any backtick run inside `value`, so nested code blocks render safely.

For the TypeScript side of variables, see [../codebase/primitives.md](../codebase/primitives.md).

## Editing

Templates hot-reload. Edit the file in Obsidian, let sync carry it into the container, then send one narrow test message.

For risky tool turns, use:

```text
@assistant !simulate test this template path
```

Then inspect the report to verify the rendered system prompt, history, current user message, agent answer, and template output.
