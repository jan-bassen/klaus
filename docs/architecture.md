# Architecture

Klaus is a small loop around one idea: WhatsApp messages become typed turns, turns gather vault context and tools, the model decides what to do, and durable state lands in the Obsidian vault or the local data store.

```text
WhatsApp
  -> pipeline parse/config/history
  -> context variables + tools + templates
  -> chat-completions loop
  -> replies, vault changes, schedules, reports, data stores
```

The architecture stays useful because the same shape appears at every level. User-owned behavior lives in `{vault}/Klaus/`. New runtime behavior lives in `src/`. Flat files carry state. There is no database and no hidden admin UI.

## Authoring Surfaces

Most tinkering happens in three places:

| Surface | Use | Reload |
| --- | --- | --- |
| WhatsApp | Route messages, run commands, apply one-turn overrides. | immediate |
| `{vault}/Klaus/` | Agents, prompts, settings, templates, reports. | hot |
| `src/` | New commands, variables, tools, toolsets, stores, pipeline behavior. | restart |

If you understand those surfaces, the rest of Klaus is mostly file placement.

## Turn Flow

Inbound WhatsApp messages enter through `src/infra/whatsapp/receive.ts` and are handled by the pipeline:

1. Auth checks the allowed chat. Without an allowed chat, Klaus enters setup mode.
2. `parseMessage` handles voice transcription, document parsing, image/sticker vision media, quoted media, `/commands`, `@agent` routing, and `!overrides`.
3. The agent and turn config are resolved from settings, agent frontmatter, and one-turn overrides.
4. The user message is stored unless the turn is ghosted.
5. Context variables, tools, history, and templates are assembled.
6. The model loop runs until it replies or reaches the step limit.
7. Reports are written, traces are persisted, and persistent agents schedule their next run.

Scheduled, timer, persistence, and dispatch runs enter through `src/pipeline/dispatch.ts` and converge on the same execution path.

For the code-level details, see [codebase/pipeline.md](codebase/pipeline.md).

## Vault Model

The repo `vault/` directory is only the first-run template. At runtime Klaus reads and watches the user's synced `{vault}/Klaus/` folder:

```text
agents/       agent Markdown files
skills/       loadable reference docs
snippets/     reusable prompt fragments
templates/    render wrappers for messages, reports, help, errors
reports/      optional Markdown report mirror
overrides.yml one-turn config presets
settings.yml  strict runtime settings
```

`ensureDefaults()` copies the bundled `vault/` tree only when `{vault}/Klaus/` does not exist. Once it exists, the folder is user-owned state. Klaus does not merge repo defaults into it or backfill missing files.

For vault files, start with [vault/agents.md](vault/agents.md), [vault/prompts.md](vault/prompts.md), and [vault/settings.md](vault/settings.md).

## Primitives

Primitives are the extension points under `src/primitives/`:

| Primitive | Purpose |
| --- | --- |
| Commands | Deterministic `/command` handlers that bypass the LLM. |
| Variables | Handlebars namespaces such as `{{time.*}}` and `{{media.*}}`. |
| Tools | Model-callable functions such as `reply`, `react`, and `skill_get`. |
| Toolsets | Lazy groups exposed through `load_<name>` meta-tools. |
| Provider tools | Server-side OpenRouter tools passed through to the request. |

Drop in a file, export the right shape, restart, and the registry loader picks it up. See [codebase/primitives.md](codebase/primitives.md).

## State And Reports

The Obsidian vault is knowledge and user-owned configuration. The data directory is runtime state:

| Store | Format | Purpose |
| --- | --- | --- |
| `history` | JSONL, day-partitioned | Conversation events, traces, reactions, breaks. |
| `report` | JSONL, day-partitioned | Per-turn execution records. |
| `files` | JSONL index + blobs | Uploaded file metadata and content. |
| `schedules` | JSON + croner | Recurring runs. |
| `timers` | JSON + setTimeout | One-shot future runs. |

Reports are the main debugging surface. They include the rendered prompt, variables, history, tool calls, results, simulated actions, and errors. See [vault/reports.md](vault/reports.md).
