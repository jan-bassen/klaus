# Reports

A report is the full record of a single turn, written to your vault as Markdown. When something behaves unexpectedly, the report is the first place to look: it shows you exactly what the model saw and did, with nothing hidden behind the curtain.

Reports land at `{vault}/Klaus/reports/<date>/<time>--<runId>.md`, so they sort chronologically and you can open them straight from Obsidian.

## When a report is written

Every run writes one report unless `config.report` is false (you can turn it off per agent with `report: false`, or per turn with an override). Reports are also skipped for [ghosted](overrides.md#ghost-mode) turns and for aborts. If a turn fails before the normal agent report can be written, Klaus writes a smaller pipeline error report with the failure phase, the user-facing error text, and the stack trace. Report writing never throws, so a problem here can never break a turn.

## What's in one

A report contains, in order:

- **Message metadata** and the trigger (`message` / `schedule` / `timer` / `dispatch`), the duration, and the outcome.
- **When something failed:** the pipeline phase, user-facing error text, and stack trace.
- **The applied overrides** and a picked subset of the resolved config.
- **When the model ran:** the model and tier, token usage, prompt size, and reply size.
- **The output**, when the run produced one.
- **Every step**, with its tool calls and their results, in the order they ran.
- **The rendered inputs:** user message, history transcript, system prompt, and context summary (variables, tools, server tools, toolsets, skills).

The top of the report is meant for fast debugging: outcome, final output, and the model/tool trace are visible before the longer rendered inputs. When you need to understand why the run behaved that way, keep reading into the user message, history, and system prompt. The rendered system prompt is where you catch a prompt-injection attempt, a snippet that didn't interpolate, or a template that wrapped something the wrong way.

Base64 data URLs are stripped from every field, so an image-heavy turn produces a readable report instead of a multi-megabyte wall of encoded bytes. A readable media marker and the stored filename are kept in their place.

## Tuning the format

The report layout is itself a [template](templates.md) (`report.md` in `{vault}/Klaus/templates/`), so you can reshape what a report shows and how it reads without touching code. The builder that assembles the data is `pipeline/reports.ts`.

---

**Related:** [examples](../examples/) · [templates](templates.md) · [iteration](../iteration.md) · [pipeline](../codebase/pipeline.md) · [agents](agents.md)
