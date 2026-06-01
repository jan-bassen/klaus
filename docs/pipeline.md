# Pipeline

`src/pipeline/` is the engine: everything that happens during a single turn, from an inbound WhatsApp message to a reply, vault changes, and a report. This page covers the turn lifecycle, the `TurnConfig` build and overrides, template rendering, the model loop, persistence and schedules, and reports.

## Files

| File | Role |
| --- | --- |
| `index.ts` | `handleTurn` — the inbound orchestrator: auth → parse → route → config → persist → execute. |
| `message.ts` | `parseMessage` — STT/doc normalise, `/command`, `/next` prefix, `@agent`, `!overrides`. |
| `next.ts` | Per-chat single-use `/next` prefix store. |
| `overrides.ts` | `TurnConfig` shape, the `overrides.yml` preset registry, the layered config merge. |
| `agents.ts` | Agent schema, registry, default-agent resolution (see [agents.md](agents.md)). |
| `context.ts` | `assembleContext` — variables + tools + history. |
| `templates.ts` | Handlebars template loader; system/user/agent-message rendering. |
| `core.ts` | The model loop (`runAgent`/`runLoop`), `TurnContext`, `Trigger`, trace persistence. |
| `dispatch.ts` | Entry point for schedule/timer/sub-agent runs. |
| `persistence.ts` | `persistDynamic` — the forced reschedule call. |
| `schedules.ts` | Frontmatter-schedule entry factory. |
| `runs.ts` | Registry of active `AbortController`s for panic-stop and supersede. |
| `outbound.ts` | Persists assistant messages, resolves quote refs, dedup keys. |
| `reports.ts` | Per-turn Markdown report builder. |
| `media.ts` | STT, TTS, vision downscale, document parsing, image generation. |

## Turn lifecycle

An inbound message flows through `handleTurn`:

1. **Auth.** `checkAllowlist` is fail-closed: an unset `allowedChat` enters setup mode; a non-matching chat is dropped silently; the configured chat proceeds.
2. **Parse.** `parseMessage` transcribes audio and extracts documents, prepends any armed `/next` prefix, then pulls off `/command`, `@agent`, and `!overrides`. Quoted media is resolved so vision and document tools can see it.
3. **Command short-circuit.** If the message was a command, its handler runs and the turn ends — no model call.
4. **Resolve agent and config.** The agent is `@route` or the chat default; `buildTurnConfig` layers the config (below).
5. **Persist the user message** (skipped when the turn is ghosted).
6. **Supersede control.** A newer message for the same `chat:agent` aborts an in-flight older one, so a quick follow-up wins.
7. **Execute.** `executeAgent` assembles context, renders prompts, and runs the model loop.
8. **Finish.** Reports are written, traces persisted, and persistent agents schedule their next run.

Errors are caught at the top: abort errors are swallowed, anything else is logged, sent to the chat as a formatted error, persisted as a failed assistant row, and marked with a ❌ reaction.

### Other entry points

Scheduled runs, timers, persistence reschedules, and `run_agent` calls do not have an inbound message. They enter through `dispatch()` and converge on `executeAgent` with a synthesised `Trigger` (`message` / `schedule` / `timer` / `dispatch`). These runs carry no `message`, so their history is empty and their user content comes from the agent's `# Message` template or the dispatch prompt. Sub-agent replies are collected and returned to the caller instead of being sent to WhatsApp; `dispatch()` also enforces `settings.agent.maxChainDepth` to stop runaway chains.

## Overrides

`TurnConfig` is the resolved per-turn settings object. It is built by layering three sources, last wins:

```
global defaults  →  agent frontmatter  →  !overrides
```

- **Global defaults** contribute only `provider` and `modelTier`.
- **Frontmatter** maps the agent's tri-state fields to flags: `voice: on` → `forceVoice`, `voice: off` → `suppressVoice`, `temp`/`topP`/`reasoningEffort` presets, plus `stepLimit`, `historyLimit`, `historyScope`, `showTools`, `report`, `vault`.
- **`!overrides`** are preset names from `{vault}/Klaus/overrides.yml`; each matched preset's settings are assigned in order. A few keys are override-only: `skipHistory`, `ghost`, and `toolChoice`.

Two special rules: `vault` access maps are deep-merged across all three layers (a per-agent grant survives the global baseline), and `!voice` (forceVoice) always clears `suppressVoice` so it wins over an agent set to `voice: off`.

Presets are loaded from `overrides.yml` at startup and on hot-reload. Each entry is `{ aliases?, description, overrides }`, registered under its name and every alias. `parseOverrides` recognises `!name`/`!alias` words; unrecognised `!words` are left in the message text.

**Ghost mode** (`!ghost`, override-only) makes a turn ephemeral: the user message, the trace, and the assistant message are all skipped, leaving no conversation record.

## Templates

Template files live in `{vault}/Klaus/templates/*.md` and are loaded and compiled at startup, each registered as a Handlebars partial so templates can include one another. They hot-reload on edit. `renderTemplate` throws a clear error if a required template file is missing.

| Template | Used for |
| --- | --- |
| `message-user` | Renders the inbound user message into model input. |
| `message-agent` | Wraps the agent's outgoing text before it is sent. |
| `history-user` / `history-agent` | Render past messages into the history transcript. |
| `persistence` | The prompt for the forced `persist` reschedule call. |
| `report` | The per-turn Markdown report. |
| `welcome` / `help` / `error` | Setup welcome, `/help` output, user-facing errors. |

The agent's own `# System` body is not a vault template — it is compiled directly as a Handlebars template against the [variable namespace](primitives.md#variables). The user message is built from the inbound message, or (for messageless runs) from `# Message` or the dispatch prompt. Inbound or quoted images are passed through as vision parts alongside the rendered text.

Sampling is resolved from the config presets against `settings.sampling`: temperature and top-p map to their preset values, and the normalised temperature is multiplied by the provider's native scale at request time.

## The model loop

`runAgent` resolves the model (`provider` + `modelTier` → base URL, key, model id) and runs `runLoop` up to the step limit:

1. The active tool list is serialised to JSON Schema; server tools are appended verbatim. When `toolChoice` is `none`, only `send_message` is offered.
2. The request is made with manual retries — per-attempt timeout, exponential backoff, and a deliberately narrow retryable set (5xx and network errors retry; timeouts, 429s, 4xx, and "prompt too long" do not).
3. Tool calls are executed; unknown tools and thrown errors come back as `{ error }` results the model can react to.
4. If the model returns no tool calls but `send_message` is active, its plain text is wrapped into a synthetic `send_message` (the fallback path) and the loop ends.
5. Otherwise the loop appends the results and may activate toolsets or skills for the next step.

The reply is the concatenation of every accepted `send_message` text. Traces (steps, tool calls, results) are persisted to history unless the turn is ghosted; `send_message` calls are dropped from the stored trace since the message itself is already recorded.

## Persistence and schedules

**Frontmatter schedules** become cron entries (`frontmatter:<agent>:<index>`) that Klaus registers at startup and re-syncs on hot-reload. When one fires, the agent runs with its `# Message` rendered against `{{schedule.*}}`.

**`persist: true`** triggers a second, separate model call after the main run, using the `persistence` template and a forced `persist` tool. The tool returns `{ nextRun, prompt, overrides? }`, and Klaus creates a one-shot timer for the next run. There is no fallback here on purpose: if the model fails to call `persist`, the run throws so the broken chain is visible rather than silently stopping. `nextRun` accepts an ISO timestamp or a compact duration (`\d+[smhd]`), clamped to `settings.persistence.minNextRun`/`maxNextRun`, falling back to `defaultNextRun` when unparseable.

The clocks themselves (croner schedules, `setTimeout` timers) live in [infra stores](infra.md#stores) and only run once setup is complete and WhatsApp is connected.

## Reports

When `config.report` is not false, every run writes one Markdown file to `{vault}/Klaus/reports/<date>/<time>--<runId>.md`. Reports are skipped for ghosted turns and for aborts, and report writing never throws.

A report contains: message metadata, trigger, duration, outcome, the applied overrides, a picked subset of the config, and — when the model ran — the model and tier, the context summary (variables, tools, server tools, toolsets, skills), token usage, every step with its tool calls and results, and the fully rendered system prompt, user message, and history transcript. That rendered prompt is the main surface for spotting injection or formatting bugs. Base64 data URLs are stripped from all fields so images do not bloat the file.

---
---
---
---
---
## [Continue to Primitives](primitives.md)
