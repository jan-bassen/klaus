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
| `templates.ts` | Template loading, Handlebars helpers, system/user rendering. |
| `core.ts` | Model loop, tool calls, traces, dynamic persistence, reports. |
| `runs.ts` | Shared active-run registry used by `/stop` to abort in-flight message, timer, schedule, and agent-task runs. |
| `outbound.ts` | Send/reaction preparation, quotes, dedup keys, trace persistence. |
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
  -> pipeline/context.ts + pipeline/templates.ts
  -> pipeline/core.ts
  -> primitives/tools/* + pipeline/outbound.ts + pipeline/reports.ts
```

`parseMessage` does the messy edge work before the model sees anything: transcribes voice, extracts documents, prepares images and stickers for vision, normalizes spoken routes, detects `/commands`, resolves `@agent`, and strips `!overrides`. `handleTurn` resolves quoted media before dispatching a command, so commands such as `/image` can use a quoted image as input.

## Config Resolution

Turn config is layered:

1. Global defaults from `settings.yml`
2. Agent frontmatter
3. Parsed one-turn overrides

Overrides are config only. They should not carry prompt content. Agent prompts and reusable prompt material live in vault Markdown; see [../vault/agents.md](../vault/agents.md) and [../vault/prompts.md](../vault/prompts.md).

## Execution

`executeAgent` gathers variables, tool definitions, provider tools, and history. `templates.ts` renders the templates, then `core.ts` runs the chat-completions loop until the model stops calling tools or the turn reaches its step limit.

Agents should send user-visible text through `send_message`. The tool requires nonblank `text`, accepts optional `asVoiceNote`, and accepts optional integer `quoteMessageLabel` for WhatsApp quotes (`0` for the current message, positive visible `[#n]` labels for older messages). Omitting `quoteMessageLabel` sends a normal message. `forceVoice` and `suppressVoice` still override the model's voice choice. If a message-capable turn ends with plain assistant content instead of tool calls, `core.ts` treats that text as a fallback `send_message` call, logs a warning, and marks the report step with `fallback: "assistant_content_reply"`. Empty assistant content still means no reply, and `toolChoice: "none"` keeps tools disabled.

Successful TTS messages persist the original text with `voice: true` on the assistant history row. OpenRouter TTS requests use `media.voice.tts.responseFormat`; PCM responses are encoded to Ogg Opus and sent with WhatsApp's voice-note flag. Text fallbacks after TTS failure remain normal text rows.

Reactions are replayed as metadata on real history messages, not as separate history slots. `historyLimit` still counts message rows; selected rows can include `{{reactions}}` such as `alpha ✅` or `user ❤️`, so a reaction-only agent turn is visible without shrinking the transcript window.

Tools return values for the model to act on. User-correctable failures should be returned as values, not thrown. Throw only at system boundaries where continuing would hide a runtime problem.

## Dispatch And Persistence

Dispatch runs do not start from an inbound WhatsApp message. They synthesize a `Trigger`, then enter the same execution path:

- Cron schedules from agent frontmatter
- One-shot timers
- Dynamic persistence follow-ups
- Inline `run_agent` tool calls

Frontmatter schedules render the agent's `# Message` section with `{{schedule.*}}`. Timer and agent-task runs prefer the agent's `# Message` section with `{{dispatch.prompt}}`, falling back to the raw objective for agents without that section. Dynamic persistence forces a final `persist` tool call after the main turn; if that call fails, the chain breaks visibly.

Inline `run_agent` messages return to the caller as the tool result. They are not auto-sent to WhatsApp; the caller decides what, if anything, to tell the user. Timer and schedule runs have no caller, so their `send_message` calls send directly to WhatsApp.

Schedules and timers do not store a chat target. Klaus is a single-chat runtime: when future work fires, it resolves the current `settings.allowedChat`.

Startup loads and syncs schedules/timers while their clocks are paused. `activateFutureWorkIfReady()` starts them only after `settings.allowedChat` exists and WhatsApp is connected. If WhatsApp disconnects, clocks pause again and resume on reconnect. `/stop` manually pauses future-work clocks without deleting schedule/timer state; `/resume` unpauses them. Cron schedules do not backfill missed ticks; timers whose `runAt` is already past fire as soon as activation starts them.

## Reports

Reports are emitted unless `turn.config.report === false`. They include the assembled variable names, explicit tools, toolsets, and skill names alongside prompts, history, steps, tool calls, and tool results. Toolset members stay grouped by set in the context summary; individual calls still appear in the step trace with their returned values. Inline agent-task messages are visible as the parent `run_agent` tool result. The human-facing agent message is derived from nonblank `send_message.text` tool calls only; malformed or empty calls remain visible in the step trace without becoming separator-only message fragments. `send_message` step args keep `asVoiceNote` before long `text` values for readable truncation. The report path and vault Markdown mirror are configured in `settings.yml`; the runtime log records the report filename and whether a vault mirror was written. See [../vault/reports.md](../vault/reports.md).
