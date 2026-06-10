# AGENTS.md

Guidance for coding agents working in this repository. This file is the essentials you should always keep in context: what Klaus is, where the docs live, the conventions that matter most, and a pointer to the full development guide. Reference documentation is **not** duplicated here — it lives once in `docs/`.

The complete how-to-work-here picture (local loop, adding primitives, testing, layout) is in [docs/development.md](docs/development.md). Read it when you start writing code.

## Status

- In development; nothing is deployed. If you change something, clean up after it — no legacy code, no compatibility shims.
- Keep the docs in sync with every change: the affected `docs/` page, the `README.md` front door, and this file. Include doc updates in your plans.

## What Klaus is

A maximally simple, headless personal AI agent: **WhatsApp → TypeScript → Obsidian vault → Docker**.

Node 25, native TypeScript (strict), Zod, Handlebars, Baileys. Models go through a thin custom loop against any OpenAI-compatible `/chat/completions` endpoint (default OpenRouter); request/response types come from the `@openrouter/sdk`. LiteParse for documents, sharp for images. JSONL for conversations and the file index, single JSON files for schedules and timers. No database.

The code is three zones, each documented once:

- `src/pipeline/` — per-turn orchestration. [docs/codebase/pipeline.md](docs/codebase/pipeline.md)
- `src/primitives/` — pluggable tools, commands, variables. [docs/codebase/primitives.md](docs/codebase/primitives.md)
- `src/infra/` — vault + sync, WhatsApp, stores, runtime. [docs/codebase/infra.md](docs/codebase/infra.md)

## Where the docs live

`docs/` is the canonical reference. The **guides** read start to end; the **reference** is for looking up a detail.

| Guide | Covers |
| --- | --- |
| [setup.md](docs/setup.md) | Install, first boot, WhatsApp login, operations |
| [usage.md](docs/usage.md) | WhatsApp surface: routing, commands, overrides, voice |
| [iteration.md](docs/iteration.md) | The loop of changing and debugging Klaus |
| [development.md](docs/development.md) | Extending Klaus in code (the full dev picture) |
| [examples/](docs/examples/) | Follow-along feature builds |

| Reference — vault (`{vault}/Klaus/`, hot-reloads) | Reference — codebase (`src/`, restart) |
| --- | --- |
| [agents](docs/vault/agents.md), [snippets](docs/vault/snippets.md), [skills](docs/vault/skills.md), [templates](docs/vault/templates.md), [overrides](docs/vault/overrides.md), [reports](docs/vault/reports.md), [settings](docs/vault/settings.md) | [pipeline](docs/codebase/pipeline.md), [primitives](docs/codebase/primitives.md), [infra](docs/codebase/infra.md) |

The split is by what you edit: vault docs cover files the user edits in Obsidian (hot-reload); codebase docs cover `src/` (restart). Templates and reports are vault surfaces even though their rendering lives in `pipeline/`; settings is a vault surface even though its loader lives in `infra/`.

## Conventions that matter most

The full list is in [development.md](docs/development.md#code-conventions). The ones to internalise:

- Prefer removing code to adding it. No knobs, abstractions, or migration burden unless behaviour truly needs to be runtime-configurable.
- Errors are values to be returned; only throw at true system boundaries.
- Fully typesafe. No `any`, no convenient `as`.
- No inline magic numbers — use `settings.*` or a template helper.
- Comments explain *why*, never *what*. No barrel imports; explicit relative `.ts` paths.
- Prompt authoring surfaces should stay beginner-friendly. Agents, snippets, and templates may use short HTML comments as human notes; Klaus strips them before rendering, and the docs should describe any new prompt/template convention.
- Core reply/control tools (`send_message`, `set_reaction`, `send_image`, `return_result`, `end_turn`) come from the invocation context, not agent frontmatter. Keep them out of bundled `tools:` lists.
- Timers are stored as ISO instants; any user-visible listing should format them with `settings.locale` and `settings.timezone`.
- `vault/settings.yml` (repo) is the first-run template only. At runtime Klaus reads the user's `{vault}/Klaus/settings.yml` directly and does not merge repo defaults. Zod validates with no `.default()` fallbacks, so a new setting needs editing both the schema in `src/infra/config.ts` and the template.
- Security-sensitive defaults should be documented plainly. WhatsApp auth is chat-scoped; a configured group chat lets every group member drive Klaus. The temporary `_login` folder contains live WhatsApp linking credentials while it exists. The bundled `agentDefaults.vaultAccess` grants read access to the whole vault except `Klaus/`, so docs should recommend E2EE Obsidian vaults, trusted setup devices, and explicit `none` rules for sensitive folders.

## Commands

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
npm run publish -- <dockerhub-user>
npm run dev    # run the built image against the klaus-vault / klaus-data volumes
```

## Vault layout (`{vault}/Klaus/`)

```
agents/       # agent .md files            snippets/     # prompt fragments → {{snippets.<name>}}
skills/       # on-demand reference docs    templates/    # render wrappers (message/history/report/...)
reports/      # Markdown report output      overrides.yml # !preset definitions
settings.yml  # strict YAML settings (hot-reloaded)
```

Reports are debug-first: they keep the outcome, output, error details, reasoning, and step trace near the top, then put the rendered user message, history, system prompt, and context details below.

`ensureVaultDefaults` copies the repo `vault/` tree into `{vault}/Klaus/` only when that folder does not exist. Once it exists it is user-owned state.
