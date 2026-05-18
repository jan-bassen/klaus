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
- Variable summaries
- Rendered system prompt, user message, and history transcript
- LLM steps
- Tool calls and results
- Simulated actions
- Errors and trace output

They intentionally include verbatim prompt and history text so prompt bugs, injection, missing variables, and wrong history scope are visible.

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
4. Check the rendered system prompt, user message, variables, history, and tool calls.
5. Fix the smallest agent, snippet, skill, override, setting, or template that explains the behavior.

For pipeline internals, see [../codebase/pipeline.md](../codebase/pipeline.md).
