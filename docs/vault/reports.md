# Reports

Reports are the main way to understand what Klaus actually did. They show the rendered prompt, available variables, history, tool calls, results, errors, and trace output.

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
The process log announces each emitted report by filename, plus whether a vault Markdown mirror was written.

## Contents

Reports include:

- Agent, trigger, model, provider, and overrides
- Available variable names, explicit tools, toolsets, and skills for the run
- Rendered system prompt, history transcript, current user message, and agent answer
- LLM steps, rendered in Markdown as `Step N` / `Finish` sections with token usage, fenced reasoning, tool calls, and tool results
- Tool calls and results
- Simulated actions
- Errors and trace output

Toolset members stay grouped in the context summary, so a `vault` toolset appears as `vault` instead of every individual vault helper. Individual tool calls still appear in the step trace.

They intentionally include rendered prompt and history text so prompt bugs, injection, missing variables, and wrong history scope are visible. Image data URLs are redacted from the text mirror; the surrounding message template still records readable media metadata such as `input: image filename` when available.

Step arguments keep short metadata before long content where that improves scanability. For example, `send_message` calls with `asVoiceNote: true` render the voice flag before the message text so it remains visible even when the text is truncated.

Markdown step results are fenced and truncated for readability. Inline `run_agent` calls show the child agent's returned message there, which makes parent/child debugging possible from the caller's report.

Markdown report prompt blocks use fences long enough to contain nested code blocks from snippets, skills, or user messages without breaking the rendered report.

## Debug Loop

For a weird message:

1. Send a narrow reproduction message.
2. Open the newest report.
3. Check the rendered system prompt, history, current user message, agent answer, variables, and tool calls.
4. Fix the smallest agent, snippet, skill, override, setting, or template that explains the behavior.

For pipeline internals, see [../codebase/pipeline.md](../codebase/pipeline.md).
