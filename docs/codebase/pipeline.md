# Pipeline

`src/pipeline/` is the engine. It owns everything that happens during a single turn, from an inbound WhatsApp message through to a reply, any vault changes, and a report. This page walks the turn lifecycle, the `TurnConfig` build and its overrides, the model loop, and how persistence and schedules feed back into the same path.

Two things that live in `src/pipeline/` but read more naturally as vault-authoring surfaces are documented elsewhere: [templates](../vault/templates.md) (the rendering wrappers you edit as `.md` files) and [reports](../vault/reports.md) (the per-turn output that lands in your vault).

## Files

| File | Role |
| --- | --- |
| `index.ts` | `handleTurn`, the inbound orchestrator: auth → parse → route → config → persist → execute. |
| `message.ts` | `parseMessage`: STT/doc normalise, `/command`, `/next` prefix, `@agent`, `!overrides`. |
| `next.ts` | Per-chat single-use `/next` prefix store. |
| `overrides.ts` | The `TurnConfig` shape, the `overrides.yml` preset registry, and the layered config merge. |
| `agents.ts` | Agent schema, registry, default-agent resolution (see [agents](../vault/agents.md)). |
| `context.ts` | `assembleContext`: variables + tools + history. |
| `templates.ts` | Handlebars template loader and the system/user/agent-message rendering (see [templates](../vault/templates.md)). |
| `core.ts` | The model loop (`runAgent`/`runLoop`), `TurnContext`, `Trigger`, trace persistence. |
| `dispatch.ts` | Entry point for schedule, timer, and sub-agent runs. |
| `persistence.ts` | `persistDynamic`, the forced reschedule call. |
| `schedules.ts` | Frontmatter-schedule entry factory. |
| `runs.ts` | Registry of active `AbortController`s for panic-stop and supersede. |
| `outbound.ts` | Persists assistant messages, resolves quote refs, dedup keys. |
| `reports.ts` | Per-turn Markdown report builder (see [reports](../vault/reports.md)). |
| `media.ts` | STT, TTS, vision downscale, document parsing, image generation. |

## Turn lifecycle

An inbound message flows through `handleTurn` in this order:

1. **Auth.** `checkAllowlist` is fail-closed. An unset `allowedChat` drops Klaus into setup mode, a non-matching chat is dropped silently, and the configured chat proceeds.
2. **Parse.** `parseMessage` transcribes audio and extracts documents, prepends any armed `/next` prefix, then pulls off a leading `/command`, an `@agent` route, and any `!overrides`. Quoted media is resolved here so the vision and document tools can see it.
3. **Command short-circuit.** If the message was a command, its handler runs and the turn ends. No model call happens.
4. **Resolve agent and config.** The agent is the `@route` or the chat default, and `buildTurnConfig` layers the config (described below).
5. **Persist the user message** (skipped when the turn is ghosted).
6. **Supersede control.** A newer message for the same `chat:agent` aborts an in-flight older one, so a quick follow-up wins.
7. **Execute.** `executeAgent` assembles context, renders the prompts, and runs the model loop.
8. **Finish.** Reports are written, traces are persisted, and persistent agents schedule their next run.

Errors are caught at the top. Abort errors are swallowed; anything else is logged, sent to the chat as a formatted error, persisted as a failed assistant row, and marked with a ❌ reaction.

### Other entry points

Scheduled runs, timers, persistence reschedules, and `run_agent` calls have no inbound message. They come in through `dispatch()` and converge on `executeAgent` with a synthesised `Trigger` (`message`, `schedule`, `timer`, or `dispatch`). Because these runs carry no `message`, their history is empty and their user content comes from the agent's `# Message` template or the dispatch prompt. Sub-agent replies are collected and returned to the caller rather than sent to WhatsApp, and `dispatch()` enforces `settings.agent.maxChainDepth` so a chain of agents calling agents cannot run away.

## Overrides

`TurnConfig` is the resolved per-turn settings object. It is built by layering three sources, last one wins:

```
global defaults  →  agent frontmatter  →  !overrides
```

- **Global defaults** contribute only `provider` and `modelTier`.
- **Frontmatter** maps the agent's tri-state fields to flags: `voice: on` becomes `forceVoice`, `voice: off` becomes `suppressVoice`, the `temp`/`topP`/`reasoningEffort` presets resolve, and `stepLimit`, `historyLimit`, `historyScope`, `showTools`, `report`, and `vault` carry through.
- **`!overrides`** are preset names from `{vault}/Klaus/overrides.yml`. Each matched preset's settings are assigned in order. A few keys are override-only: `skipHistory`, `ghost`, and `toolChoice`.

Two rules are worth remembering. The `vault` access map is deep-merged across all three layers, so a per-agent grant survives the global baseline. And `!voice` (forceVoice) always clears `suppressVoice`, so it wins over an agent set to `voice: off`.

Presets are loaded from `overrides.yml` at startup and again on hot-reload. Each entry is `{ aliases?, description, overrides }`, registered under its name and every alias. `parseOverrides` recognises `!name`/`!alias` words; any unrecognised `!words` are left in the message text. The authoring side of this lives in [overrides](../vault/overrides.md).

**Ghost mode** (`!ghost`, override-only) makes a turn ephemeral. The user message, the trace, and the assistant message are all skipped, so the turn leaves no conversation record behind.

## The model loop

`runAgent` resolves the model (`provider` + `modelTier` give a base URL, key, and model id) and runs `runLoop` up to the step limit:

1. The active tool list is serialised to JSON Schema, and server tools are appended verbatim. Core reply tools are chosen from the trigger, with `end_turn` available as the explicit stop control. When `toolChoice` is `none`, only the trigger's text tool is offered.
2. The request is made with manual retries: a per-attempt timeout, exponential backoff, and a deliberately narrow retryable set. 5xx and network errors retry; timeouts, 429s, other 4xx, and "prompt too long" do not.
3. Tool calls are executed. Unknown tools and thrown errors come back as `{ error }` results the model can react to.
4. If the model returns no tool calls but the text reply tool is active, its plain text is wrapped into a synthetic `send_message` or `return_result` call (the fallback path) and the loop ends.
5. A successful `end_turn` call ends the loop immediately after that step; otherwise the loop appends the results and may activate toolsets or skills for the next step.

The reply is the concatenation of every accepted text tool call: `send_message` for outward runs and `return_result` for inline dispatches. Agents may send a progress message, keep working, send another message, and then call `end_turn` when finished. Traces (steps, tool calls, results) are persisted to history unless the turn is ghosted. Text reply tool calls themselves are dropped from the stored trace, since the message/result is already represented by the run reply.

## Persistence and schedules

There are two independent ways an agent runs without a fresh message. Both are declared in agent frontmatter and both converge on the normal execution path.

**Frontmatter schedules** become cron entries (`frontmatter:<agent>:<index>`) that Klaus registers at startup and re-syncs on hot-reload. When one fires, the agent runs with its `# Message` rendered against `{{schedule.*}}`.

**`persist: true`** triggers a second, separate model call after the main run, using the `persistence` template and a forced `persist` tool. The tool returns `{ nextRun, prompt, overrides? }`, and Klaus creates a one-shot timer for the next run. There is no fallback here, and that is deliberate: if the model fails to call `persist`, the run throws so a broken chain is visible rather than silently stopping. `nextRun` accepts an ISO timestamp or a compact duration (`\d+[smhd]`, e.g. `30m`, `6h`, `2d`), clamped to `settings.persistence.minNextRun`/`maxNextRun`, and falls back to `defaultNextRun` when it cannot be parsed.

The clocks themselves (croner schedules, `setTimeout` timers) live in the [infra stores](infra.md#stores) and only run once setup is complete and WhatsApp is connected. The agent-author's view of all this is in [agents](../vault/agents.md#persistence-and-schedules).

---

**Related:** [agents](../vault/agents.md) · [templates](../vault/templates.md) · [reports](../vault/reports.md) · [primitives](primitives.md) · [infra](infra.md)
