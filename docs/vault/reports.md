# Reports

A report is the full record of a single turn, written to your vault as Markdown. When something behaves unexpectedly, the report is the first place to look: it shows you exactly what the model saw and did, with nothing hidden behind the curtain.

Reports land at `{vault}/Klaus/reports/<date>/<time>--<runId>.md`, so they sort chronologically and you can open them straight from Obsidian.

## When a report is written

Every run writes one report unless `config.report` is false (you can turn it off per agent with `report: false`, or per turn with an override). Reports are also skipped for [ghosted](overrides.md#ghost-mode) turns and for aborts. Report writing never throws, so a problem here can never break a turn.

## What's in one

A report contains, in order:

- **Message metadata** and the trigger (`message` / `schedule` / `timer` / `dispatch`), the duration, and the outcome.
- **The applied overrides** and a picked subset of the resolved config.
- **When the model ran:** the model and tier, a context summary (variables, tools, server tools, toolsets, skills), and token usage.
- **Every step**, with its tool calls and their results.
- **The fully rendered system prompt, user message, and history transcript.**

That last part is the one to study. The rendered system prompt is where you catch a prompt-injection attempt, a snippet that didn't interpolate, or a template that wrapped something the wrong way. If an agent is misbehaving, read the prompt it actually received rather than the prompt you thought you wrote.

Base64 data URLs are stripped from every field, so an image-heavy turn produces a readable report instead of a multi-megabyte wall of encoded bytes. A readable media marker and the stored filename are kept in their place.

## Tuning the format

The report layout is itself a [template](templates.md) (`report.md` in `{vault}/Klaus/templates/`), so you can reshape what a report shows and how it reads without touching code. The builder that assembles the data is `pipeline/reports.ts`.

---

**Related:** [examples](../examples/) · [templates](templates.md) · [iteration](../iteration.md) · [pipeline](../codebase/pipeline.md) · [agents](agents.md)
