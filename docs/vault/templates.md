# Templates

Templates are the render wrappers that shape everything around the model: how an inbound message is presented, how history is laid out, how a report reads, and what the setup and help messages say. They live as `.md` files in `{vault}/Klaus/templates/`, which means you can tune the whole presentation layer from Obsidian without touching code.

Each template file is loaded and compiled at startup and registered as a Handlebars partial, so templates can include one another. They hot-reload on edit. If a required template file is missing, `renderTemplate` throws a clear error rather than guessing.

## The templates

| Template | Used for |
| --- | --- |
| `message-user` | Renders the inbound user message into model input. |
| `message-agent` | Wraps the agent's outgoing text before it is sent. |
| `history-user` / `history-agent` | Render past messages into the history transcript. |
| `persistence` | The prompt for the forced `persist` reschedule call. |
| `report` | The per-turn Markdown [report](reports.md). |
| `welcome` / `help` / `error` | The setup welcome, `/help` output, and user-facing errors. |

## What is and isn't a template

The distinction trips people up, so it is worth stating plainly. An agent's own `# System` body is **not** a vault template. It is compiled directly as a Handlebars template against the [variable namespace](../codebase/primitives.md#variables). The templates above are the wrappers Klaus puts *around* a turn; the agent body is the prompt *inside* it.

The user message itself is built from the inbound message, or, for messageless runs, from the agent's `# Message` or the dispatch prompt. Inbound or quoted images are passed through as vision parts alongside the rendered text.

## Author notes

HTML comments are for humans and are stripped before templates are rendered:

```markdown
<!-- Shapes each inbound WhatsApp turn before it reaches the model. -->
[{{time}}]: {{messageText}}
```

Use visible prose only for text the model, user, or report should actually receive. This same comment-stripping convention also applies to agent prompt bodies and [snippets](snippets.md).

## A note on caching

Because templates feed the prompt that is re-sent on every step, keeping the stable ones byte-stable helps providers cache the prompt prefix. The same advice as for agent bodies applies: keep volatile values out of the parts that repeat every turn. The rendering mechanics live in the [pipeline](../codebase/pipeline.md#templates).

---

**Related:** [reports](reports.md) · [agents](agents.md) · [snippets](snippets.md) · [pipeline](../codebase/pipeline.md)
