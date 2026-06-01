# AGENTS.md

Guidance for coding agents working in this repository. Reference documentation is **not** duplicated here — it lives once in `docs/`. This file is conventions plus a map.

## Status

- In development; nothing is deployed. If you change something, clean up after it — no legacy code, no compatibility shims.
- Keep the docs in sync with every change: the affected `docs/` page, the `README.md` front door, and this file. Include doc updates in your plans.

## Where the docs live

`docs/` is the canonical reference, organised to mirror the code and read start to end:

| Page | Covers | Source it documents |
| --- | --- | --- |
| [docs/setup.md](docs/setup.md) | Install, first boot, WhatsApp login, troubleshooting | Docker, env, sync |
| [docs/architecture.md](docs/architecture.md) | The map: three code zones + turn flow | whole `src/` |
| [docs/usage.md](docs/usage.md) | WhatsApp surface: routing, commands, overrides, voice | `pipeline/message.ts`, `commands/` |
| [docs/agents.md](docs/agents.md) | Agent files, frontmatter, schedules, persistence, vault access | `pipeline/agents.ts`, `vault/agents/` |
| [docs/pipeline.md](docs/pipeline.md) | Turn lifecycle, templates, overrides, reports | `src/pipeline/` |
| [docs/primitives.md](docs/primitives.md) | Tools, commands, variables, snippets, skills | `src/primitives/` |
| [docs/infra.md](docs/infra.md) | Settings, vault + sync, WhatsApp, stores | `src/infra/` |

Templates are documented with the pipeline (the rendering logic lives there); stores are documented with infra (they live under `infra/store/`).

## What Klaus is

A maximally simple, headless personal AI agent: **WhatsApp → TypeScript → Obsidian vault → Docker**.

Node 25, native TypeScript (strict), Zod, Handlebars, Baileys. Models go through a thin custom loop against any OpenAI-compatible `/chat/completions` endpoint (default OpenRouter); request/response types come from the `@openrouter/sdk`. LiteParse for documents, sharp for images. JSONL for conversations and the file index, single JSON files for schedules/timers. No database.

## Code conventions
- Short, clean, readable. Prefer removing code to adding it. Don't add knobs, abstractions, or migration burden unless behaviour truly needs to be runtime-configurable. Tune bundled `vault/templates/` with existing helpers before adding settings.
- Errors are values to be returned, only throw at true system boundaries.
- Fully typesafe! No `any`, no convenient `as`.
- No inline magic numbers, prefer `settings.*` or template helpers.
- `vault/settings.yml` (repo) is the first-run template. At runtime Klaus reads the user's `{vault}/Klaus/settings.yml` directly; it is not merged with repo defaults. Zod validates only — no `.default()` fallbacks. A new field needs editing both the schema in `src/infra/config.ts` and the template.
- Comments explain *why*, never *what*. Prefer good naming.
- Keep the dependency list short; `npm install` only when genuinely needed. Don't use auto-upgrades.
- No barrel imports. Specific relative module paths with explicit `.ts` extensions.

## Testing conventions

- Vitest, `pool: forks` for module isolation. Tests in `test/` mirror `src/`.
- Keep the implementation clean of test seams. Confirm with the user if one is truly needed.
- Optimise for critical paths (pipeline, tool execution, store round-trip). No coverage targets.
- `test/setup.ts` preloads `src/infra/config.ts` (the logger reads settings eagerly) and clears registries in `afterEach`. Helpers in `test/helpers/{tmp,stores,turn}.ts`.
- Module mocking: `vi.hoisted()` + `vi.mock("../relative/path.ts", ...)`. For settings overrides, mutate the live `settings` object in `beforeEach`.

## Commands

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
npm run dev    # run the built image against the klaus-vault / klaus-data volumes
```

## Directory layout

Intentionally flat and opinionated — one glance should tell a newcomer where to look.

```
src/
├── index.ts          # bootstrap / startup sequence
├── errors.ts         # user-facing error formatting
├── pipeline/         # per-turn orchestration (see docs/pipeline.md)
│   ├── index.ts      # handleTurn — auth + full turn
│   ├── message.ts    # parseMessage (STT, commands, /next, @agent, !overrides)
│   ├── next.ts       # single-use per-chat prefix
│   ├── overrides.ts  # TurnConfig + !preset registry + merge
│   ├── agents.ts     # Agent schema + registry + default agent
│   ├── context.ts    # variables + tools + history assembly
│   ├── templates.ts  # system/user/agent-message rendering
│   ├── core.ts       # model loop (runAgent/runLoop), TurnContext, Trigger
│   ├── dispatch.ts   # schedule/timer/sub-agent entrypoint
│   ├── persistence.ts# forced persist reschedule
│   ├── schedules.ts  # frontmatter-schedule entries
│   ├── runs.ts       # active AbortController registry
│   ├── outbound.ts   # assistant message persistence + quote refs
│   ├── media.ts      # STT, TTS, doc parse, image prep/gen
│   └── reports.ts    # per-turn report emitter
├── primitives/       # pluggable extensions, auto-discovered (see docs/primitives.md)
│   ├── tools/        # send_message, set_reaction, search_messages, send_image, math,
│   │                 # skill, server + sets/{vault,files,dispatch}
│   ├── variables/    # time, media, tasks, dispatch, config, schedule, trigger, snippets
│   └── commands/     # break, default, help, image, model(+provider), next, resume,
│                     # retry, schedules, stop, voice
└── infra/            # external systems + state (see docs/infra.md)
    ├── config.ts     # YAML settings + env paths + model resolution (live mutable `settings`)
    ├── runtime.ts    # fs helpers (read/write/scan)
    ├── future.ts     # schedule/timer start-pause gate
    ├── logger.ts
    ├── store/        # history, files, schedules, timers
    ├── vault/        # path resolution, defaults, sync, watcher, permissions, markdown
    └── whatsapp/     # connection, login, presence, receive, send
```

## Vault layout (`{vault}/Klaus/`)

```
agents/       # agent .md files            snippets/     # prompt fragments → {{snippets.<name>}}
skills/       # on-demand reference docs    templates/    # render wrappers (message/history/report/...)
reports/      # Markdown report output      overrides.yml # !preset definitions
settings.yml  # strict YAML settings (hot-reloaded)
```

`ensureVaultDefaults` copies the repo `vault/` tree into `{vault}/Klaus/` only when that folder does not exist. Once it exists it is user-owned state.
