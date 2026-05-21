# Pipeline

The pipeline owns one turn from inbound message to model execution. It is intentionally flat: each file in `src/pipeline/` handles one stage and passes typed values forward.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Top-level `handleTurn`: auth, setup mode, parse, config, persistence, execution. |
| `message.ts` | Voice/document/link parsing, `/commands`, `@agent`, `!overrides`. |
| `media.ts` | Speech-to-text, text-to-speech, document extraction, image prep. |
| `agents.ts` | Agent schema, prompt sections, aliases, registry, default agent. |
| `overrides.ts` | `TurnConfig`, override registry, config merge. |
| `context.ts` | Variables, tools, toolsets, provider tools, history, message references. |
| `prompts.ts` | Template loading, Handlebars helpers, system/user rendering. |
| `core.ts` | Model loop, tool calls, traces, dynamic persistence, reports. |
| `outbound.ts` | Reply/react preparation, quotes, dedup keys, trace persistence. |
| `dispatch.ts` | Run agents from schedules, timers, persistence, or another agent. |
| `persistence.ts` | Dynamic self-rescheduling timer creation. |
| `reports.ts` | JSON reports and optional vault Markdown mirrors. |

## Inbound Turns

The normal WhatsApp path is:

```text
infra/whatsapp/receive.ts
  -> pipeline/index.ts
  -> pipeline/message.ts
  -> pipeline/agents.ts + pipeline/overrides.ts
  -> infra/store/history.ts
  -> pipeline/context.ts + pipeline/prompts.ts
  -> pipeline/core.ts
  -> primitives/tools/* + pipeline/outbound.ts + pipeline/reports.ts
```

`parseMessage` does the messy edge work before the model sees anything: transcribes voice, extracts documents, prepares images, normalizes spoken routes, executes `/commands`, resolves `@agent`, and strips `!overrides`.

## Config Resolution

Turn config is layered:

1. Global defaults from `settings.yml`
2. Agent frontmatter
3. Parsed one-turn overrides

Overrides are config only. They should not carry prompt content. Agent prompts and reusable prompt material live in vault Markdown; see [../vault/agents.md](../vault/agents.md) and [../vault/prompts.md](../vault/prompts.md).

## Execution

`executeAgent` gathers variables, tool definitions, provider tools, and history. `prompts.ts` renders the templates, then `core.ts` runs the chat-completions loop until the model stops calling tools or the turn reaches its step limit.

Agents should send user-visible text through the `reply` tool. If a reply-capable turn ends with plain assistant content instead of tool calls, `core.ts` treats that text as a fallback `reply` call, logs a warning, and marks the report step with `fallback: "assistant_content_reply"`. Empty assistant content still means no reply, and `toolChoice: "none"` keeps tools disabled.

Tools return values for the model to act on. User-correctable failures should be returned as values, not thrown. Throw only at system boundaries where continuing would hide a runtime problem.

## Dispatch And Persistence

Dispatch runs do not start from an inbound WhatsApp message. They synthesize a `Trigger`, then enter the same execution path:

- Cron schedules from agent frontmatter
- One-shot timers
- Dynamic persistence follow-ups
- Inline `dispatch` tool calls

Frontmatter schedules render the agent's `# Message` section with `{{schedule.*}}`. Timer and dispatch-tool runs prefer the agent's `# Message` section with `{{dispatch.prompt}}`, falling back to the raw objective for agents without that section. Dynamic persistence forces a final `persist` tool call after the main turn; if that call fails, the chain breaks visibly.

Schedules and timers do not store a chat target. Klaus is a single-chat runtime: when future work fires, it resolves the current `settings.allowedChat`.

Startup loads and syncs schedules/timers while their clocks are paused. `activateFutureWorkIfReady()` starts them only after `settings.allowedChat` exists and WhatsApp is connected. If WhatsApp disconnects, clocks pause again and resume on reconnect. Cron schedules do not backfill missed ticks; timers whose `runAt` is already past fire as soon as activation starts them.

## Reports

Reports are emitted unless `turn.config.report === false`. They include the assembled variable, tool, and skill names alongside prompts, history, steps, and tool calls. Simulation turns always report and include simulated actions. The report path and vault Markdown mirror are configured in `settings.yml`; see [../vault/reports.md](../vault/reports.md).
