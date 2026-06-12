# Reports

A report is the full record of a single turn, written to your vault as Markdown. When something behaves unexpectedly, the report is the first place to look: it shows you exactly what the model saw and did, with nothing hidden behind the curtain.

Reports land at `{vault}/Klaus/reports/<date>/<time>--<runId>.md`, so they sort chronologically and you can open them straight from Obsidian.

## When a report is written

Every run writes one report unless `config.report` is false (you can turn it off per agent with `report: false`, or per turn with an override). Reports are also skipped for [ghosted](overrides.md#ghost-mode) turns and for aborts. If a turn fails before the normal agent report can be written, Klaus writes a smaller pipeline error report with the failure phase, the user-facing error text, and the stack trace. Report writing never throws, so a problem here can never break a turn.

## What's in one

A report contains, in order:

- **Message metadata** and the trigger (`message` / `schedule` / `timer` / `dispatch`), the duration, and the outcome. For WhatsApp message turns, this includes both the chat JID and sender JID so group turns can be audited.
- **When something failed:** the pipeline phase, user-facing error text, and stack trace.
- **The applied overrides** and a picked subset of the resolved config.
- **When the model ran:** the model and tier, token usage, prompt size, and reply size.
- **The output**, when the run produced one.
- **Every step**, with its reasoning, server-tool usage, tool calls, and their results, in the order they ran.
- **Recent runtime logs** from around the turn, capped to keep the report readable.
- **The rendered inputs:** user message, history transcript, system prompt, and context summary (variables, tools, server tools, toolsets, skills).

The top of the report is meant for fast debugging: outcome, final output, model reasoning, the tool trace, and the nearby runtime logs are visible before the longer rendered inputs. Server-tool citations are captured from provider responses when they are surfaced, but the bundled report template does not print citation excerpts by default because provider snippets are often noisy. When you need to understand why the run behaved that way, keep reading into the user message, history, and system prompt. The rendered system prompt is where you catch a prompt-injection attempt, a snippet that didn't interpolate, or a template that wrapped something the wrong way.

The log section is a small in-memory slice, not a full Docker log dump. It includes recent lines from just before the turn started through report writing, with a hard line cap so reports stay usable on a phone. Nearby background activity can still appear when two things happen at once, so treat it as context rather than a perfect run-scoped trace.

For `send_message`, the displayed `asVoiceNote` value is the effective delivery mode after turn config is applied. That means `!voice` shows `asVoiceNote: true` even if the model omitted or declined voice, and a voice-suppression override shows `false` even if the model requested audio.

Base64 data URLs are stripped from every field, so an image-heavy turn produces a readable report instead of a multi-megabyte wall of encoded bytes. A readable media marker and the stored filename are kept in their place.

## Tuning the format

The report layout is itself a [template](templates.md) (`report.md` in `{vault}/Klaus/templates/`), so you can reshape what a report shows and how it reads without touching code. The builder that assembles the data is `pipeline/reports.ts`.

---

**Related:** [examples](../examples/) · [templates](templates.md) · [iteration](../iteration.md) · [pipeline](../codebase/pipeline.md) · [agents](agents.md)
