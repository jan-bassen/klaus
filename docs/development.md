# Development

This guide is for the moments when a vault edit isn't enough and you need to work in the code itself. That's a smaller set of changes than you might expect, because most of what makes Klaus *yours* lives in vault files that hot-reload. If you're changing behaviour, knowledge, or tone, start with [iteration](iteration.md) instead. Come here when you want to give Klaus an ability it doesn't have, or change how the machine underneath actually works.

Those are really the two kinds of work, and the guide is shaped around them:

- **Adding a capability.** A new tool, variable, or command. This is additive and self-contained, and it's the path you'll take most often. You don't have to understand the whole codebase to do it well.
- **Changing the core.** Modifying how a turn is parsed, how the model loop retries, how vault permissions are enforced, how something is stored. This means editing the pipeline or infra directly, so it asks for a real mental model of how a turn flows.

Both start the same way: get it running, and understand the turn.

## Get it running

Klaus runs on Node 25 with npm. There's no build step for the TypeScript; it runs natively under strict type-checking, so the type checker *is* your compiler.

```bash
npm run typecheck   # tsc, strict, no emit
npm run test        # vitest
npm run test:watch  # vitest in watch mode
npx biome check --write .   # lint + format
npm run build       # build the Docker image
npm run dev         # run the built image against the klaus-vault / klaus-data volumes
```

Your inner loop is `npm run typecheck` and `npm run test` (or `test:watch`). Run `biome check --write` before you commit. When you want to exercise the change in the real container against your actual vault, `npm run build` then `npm run dev`; the operator's side of that is in [setup](setup.md). Note that code has **no hot-reload** — unlike vault files, a change in `src/` only takes effect on a restart.

## Everything serves a turn

Klaus is small because it does one thing: it turns a message into a turn. Almost every file in `src/` exists to make some part of that happen, so the fastest way to find your way around is to know the stages a turn passes through. The full mechanics are in the [pipeline reference](codebase/pipeline.md); here's the spine.

1. **Parse** (`pipeline/message.ts`). The raw message is normalised — audio transcribed, documents extracted — and any leading `@agent`, `/command`, and `!overrides` are pulled off.
2. **Command short-circuit** (`pipeline/index.ts` → `primitives/commands/`). If it was a `/command`, the handler runs and the turn ends. No model is called.
3. **Resolve and configure** (`pipeline/agents.ts`, `pipeline/overrides.ts`). The agent is chosen and its per-turn config is layered together from global defaults, frontmatter, and overrides.
4. **Assemble context** (`pipeline/context.ts`). The **variables** run to build the `{{...}}` namespace, the agent's **tools** are gathered, and history is loaded.
5. **Render** (`pipeline/templates.ts`). The agent's prompt and the surrounding templates are compiled against that namespace into the text the model receives.
6. **The model loop** (`pipeline/core.ts`). The model is called. It answers, or it calls a **tool** whose result feeds back in for another pass, up to a step limit. The reply is whatever it sends via `send_message`.
7. **Finish** (`pipeline/outbound.ts`, `pipeline/reports.ts`). The reply is sent, history and a report are written, and persistent agents schedule their next run.

Hold that sequence in your head and the codebase stops being a pile of files. It becomes a single path you can point at.

## Finding the file you need

`src/` is three zones, and each one owns a different part of that path. When you know what you want to change, this is where to look:

- **`pipeline/`** runs the turn. Anything about *how a turn behaves* lives here: parsing and routing (`message.ts`), the override merge (`overrides.ts`), what goes into the prompt (`context.ts`), prompt rendering (`templates.ts`), the model loop and its retry logic (`core.ts`), schedules and persistence (`schedules.ts`, `persistence.ts`), and reports (`reports.ts`). Reference: [pipeline](codebase/pipeline.md).
- **`primitives/`** holds the pluggable pieces a turn *uses*: the tools, variables, and commands. Adding a capability almost always means adding a file here. Reference: [primitives](codebase/primitives.md).
- **`infra/`** is the systems a turn *rests on*: settings and model resolution (`config.ts`), the vault with its sync, watcher, and permission gate (`vault/`), WhatsApp (`whatsapp/`), and the flat-file stores (`store/`). Reference: [infra](codebase/infra.md).

So "I want web search to retry differently" is `pipeline/core.ts`; "agents should be able to read a new folder by default" is the permission gate in `infra/vault/`; "store a new field on each message" is `infra/store/`. The reference page for a zone is its map.

```
src/
├── index.ts          # bootstrap / startup sequence
├── errors.ts         # user-facing error formatting
├── pipeline/         # runs the turn          → docs/codebase/pipeline.md
├── primitives/       # the pieces a turn uses → docs/codebase/primitives.md
│   ├── tools/        #   model-callable functions (+ sets/ for toolsets)
│   ├── variables/    #   {{namespace}} context
│   └── commands/     #   /slash handlers
└── infra/            # the systems underneath → docs/codebase/infra.md
    ├── config.ts     #   settings + env + model resolution
    ├── store/        #   history, files, schedules, timers
    ├── vault/        #   paths, defaults, sync, watcher, permissions, markdown
    └── whatsapp/     #   connection, login, presence, receive, send
```

## Path A — add a capability

The three code primitives are auto-discovered at startup. You drop a file in the right directory, export the right shape, and restart. There's no registration list to touch, and a file that fails to load is logged and skipped rather than crashing the boot. Each kind plugs into one of the turn stages above, which is the easiest way to remember which one you want.

### A tool — something the model can *do* (stage 6)

A tool is a function the model can call partway through composing a reply. The model decides when to call it, you receive typed arguments, you do the work, and what you return feeds back into the loop. This is how Klaus does anything beyond talk; every vault write, web search, and image generation is a tool. Add one to give agents a new ability: calling an external API, querying a service, doing a calculation you don't want the model to do in its head.

`primitives/tools/*.ts` (or `tools/sets/*.ts` for a member of a lazy toolset), exporting a `ToolDefinition`:

```ts
interface ToolDefinition<TInput extends z.ZodTypeAny> {
  name: string;
  description: string;                  // the model reads this to decide when to call it
  inputSchema: TInput;                  // Zod, serialised to JSON Schema for the model
  execute(input: z.infer<TInput>, context: TurnContext): Promise<unknown>;
  maxResultChars?: number;
  maxArgSnippetChars?: number;
}
```

The `description` and `inputSchema` are the tool's interface to the model, so write them as instructions, not just docs. Return something the model can act on, and return `{ error }` rather than throwing when something fails. A file may export one tool or an array. An agent only gets a tool it lists in frontmatter, so new tools are opt-in.

For a tool built end to end — reading a receipt image and logging it — follow the [expenses-tracker example](examples/expenses-tracker.md).

### A variable — context for every prompt (stage 4)

A variable contributes a slice of context to *every* prompt, computed fresh at the start of each turn. It exposes a top-level `{{namespace}}` that any prompt, snippet, or template can read, the way `{{time.date}}` exposes the date. Add one when you want live data in front of the model without it having to fetch it: a running total, today's calendar, the state of some external system.

`primitives/variables/*.ts`, exporting a `Variable`:

```ts
interface Variable {
  key: string;                  // the {{namespace}} it exposes
  description?: string;
  after?: boolean;              // resolve in a second phase, once other vars exist
  run(turn): Promise<unknown>;  // returns the namespace's value
}
```

Keep `run` cheap and side-effect-free; it executes on every turn before the model is called. Use `after: true` only when you need another variable's value to compute yours.

The [language-coach example](examples/language-coach.md) builds one from scratch — a `{{review}}` namespace that derives today's spaced-repetition queue from a vault note.

### A command — a deterministic action (stage 2)

A command is triggered by a `/slash` word and bypasses the model entirely: the handler runs, the turn ends, no model call. That makes commands right for exact, predictable operations where a model has no place — flipping a setting, listing schedules, stopping background work. Add one when the action has a single correct outcome and should be instant and free.

`primitives/commands/*.ts`, exporting a `Command`:

```ts
interface Command {
  name: string;
  aliases?: string[];
  params?: { name: string }[];
  description: string;
  execute(msg: InboundMessage, args: string[]): Promise<void>;
}
```

Because a command short-circuits the turn, `execute` is responsible for its own reply. Commands that change configuration tend to write to a vault file (as `/model` writes the default agent's frontmatter), so the change persists and hot-reloads.

The [expenses-tracker example](examples/expenses-tracker.md) pairs a `/expense` command (the instant, model-free path) with the tool above (the receipt-scan path), which is a good illustration of when to choose which.

## Path B — change the core

Sometimes the behaviour you want isn't a new piece bolted on, but a change to how an existing part works. The approach is always the same, and the turn spine makes it tractable:

1. **Locate the stage.** Decide which step of the turn your change belongs to, and from the zone map find the file. The reference page for that zone fills in the surrounding detail.
2. **Read the path through.** Follow the turn through that file before editing. Klaus favours a few small, explicit functions over indirection, so the path is usually short and readable.
3. **Make the change in place.** Don't add a flag or a compatibility shim to preserve the old behaviour alongside the new — nothing is deployed yet, so just change it (see the conventions below).
4. **Verify it the way it's used.** Run the critical-path tests for that area, and if it's user-visible, exercise it with `npm run dev` and read the resulting report.

A few rules bite specifically when you're in the core, so they're worth knowing before you start:

- **No hot-reload for code.** A change in `src/` needs a restart to take effect. Only vault content reloads live.
- **The permission gates are fail-closed.** Both the vault scope gate and per-agent access deny by default. If you touch `infra/vault/` permissions, the safe direction is to *grant* deliberately, never to loosen the default-deny.
- **`settings` is live and mutable.** The exported object is rebuilt in place on hot-reload and on commands like `/model`, so other modules' imports keep working. Read from it; don't cache its values at import time.
- **Adding a setting is a two-place edit.** See below.

### Adding a setting

`{vault}/Klaus/settings.yml` is validated by a strict Zod schema in `src/infra/config.ts` with no `.default()` fallbacks anywhere, and the repo's `vault/settings.yml` is only the first-run template. At runtime Klaus reads the user's synced copy and never merges repo defaults into it.

So a new setting means editing **two** files: the schema in `config.ts` and the template in `vault/settings.yml`. Miss the template and a fresh deploy boots while an existing one fails on the missing field; miss the schema and the field is silently ignored. This strictness is deliberate — a misnamed setting fails loudly at startup instead of drifting. The user-facing tour of the groups is in [settings](vault/settings.md).

## How this codebase wants you to write

The conventions exist to keep Klaus small and legible, which is the whole pitch. They aren't style preferences so much as the thing that makes the codebase stay readable enough to extend.

- **Prefer removing code to adding it.** Don't add knobs, abstractions, or migration burden unless behaviour genuinely needs to be runtime-configurable. Tune the bundled `vault/templates/` with existing helpers before reaching for a new setting.
- **Errors are values.** Return them; only throw at true system boundaries. A failing tool returns `{ error }` the model can react to, it doesn't blow up the loop.
- **Fully typesafe.** No `any`, no convenient `as`. When the types fight you, the design usually wants another look.
- **No inline magic numbers.** Tunable constants belong in `settings.*` or a template helper, never hard-coded mid-function.
- **Comments explain *why*, never *what*.** Lean on good naming for the what.
- **Keep dependencies few.** `npm install` only when something genuinely needs it, and no auto-upgrades.
- **No barrel imports.** Specific relative module paths with explicit `.ts` extensions.

## Verifying your change

`npm run typecheck` and `npm run test` are the baseline; nothing merges red. Beyond that:

- **Tests live in `test/`, mirroring `src/`**, on Vitest with `pool: forks` for module isolation. There are no coverage targets to chase. Aim your effort at the critical paths: the pipeline, tool execution, and store round-trips.
- **Keep the implementation clean of test seams.** If you think you truly need one, check with the user first.
- `test/setup.ts` preloads `src/infra/config.ts` (the logger reads settings eagerly) and clears registries in `afterEach`. Shared helpers are in `test/helpers/{tmp,stores,turn}.ts`.
- **Mocking** uses `vi.hoisted()` with `vi.mock("../relative/path.ts", ...)`. To vary settings in a test, mutate the live `settings` object in `beforeEach` rather than re-mocking the module.
- **For anything user-visible, run it for real.** `npm run dev` against your volumes, send the message, and read the [report](vault/reports.md) for that turn. The rendered prompt and the tool trace tell you whether the change did what you meant, in a way a unit test often can't.

## Keep the docs in sync

A change that alters behaviour updates its docs in the same pass: the relevant `docs/` page, the `README.md` front door if it's user-visible, and [AGENTS.md](../AGENTS.md). Treat it as part of the change rather than a follow-up, and include it when you plan the work.

---

**Related:** [examples](examples/) · [iteration](iteration.md) · [pipeline](codebase/pipeline.md) · [primitives](codebase/primitives.md) · [infra](codebase/infra.md) · [settings](vault/settings.md) · [AGENTS.md](../AGENTS.md)
