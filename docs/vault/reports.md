# Reports

Reports are the main way to understand what Klaus actually did. They show the rendered prompt, available variables, history, tool calls, results, simulated actions, errors, and trace output.

## Files

When enabled, each run writes JSON under:

```text
{dataDir}/logs/<date>/
```

If `reports.vaultMarkdown: true`, Klaus also mirrors a readable Markdown report to:

```text
{vault}/Klaus/reports/<date>/
```

Report behavior is configured in [settings.md](settings.md). Report emission can also be controlled per agent or per turn.

## Contents

Reports include:

- Agent, trigger, model, provider, and overrides
- Available variable, tool, and skill names for the run
- Rendered system prompt, history transcript, current user message, and agent answer
- LLM steps, rendered in Markdown as compact one-based tool blocks with token usage and optional reasoning
- Tool calls and results
- Simulated actions
- Errors and trace output

They intentionally include rendered prompt and history text so prompt bugs, injection, missing variables, and wrong history scope are visible. Image data URLs are redacted from the text mirror; the surrounding message template still records the media as `Image` with a stored filename when available.

Markdown report prompt blocks use fences long enough to contain nested code blocks from snippets, skills, or user messages without breaking the rendered report.

## Simulation

`!simulate` turns always emit reports and are tagged as simulation runs.

```text
@assistant !simulate clean up Projects/Klaus/Inbox.md
```

Under simulation, external and stateful tool calls do not perform real side effects. The report includes the simulated actions list so you can inspect what would have happened.

## Debug Loop

For a weird reply:

1. Send a narrow reproduction message.
2. Add `!simulate` if tools could write, schedule, upload, or send.
3. Open the newest report.
4. Check the rendered system prompt, history, current user message, agent answer, variables, and tool calls.
5. Fix the smallest agent, snippet, skill, override, setting, or template that explains the behavior.

For pipeline internals, see [../codebase/pipeline.md](../codebase/pipeline.md).
