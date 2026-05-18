# Internals

Klaus is easiest to understand as one tree. Startup lives in `src/index.ts`, turns move through `src/pipeline/`, extension points live in `src/primitives/`, external systems live in `src/infra/`, first-run user files live in `vault/`, and tests mirror the source tree.

```text
.
├── README.md                         # short public front door
├── AGENTS.md                         # repo instructions for coding agents
├── Dockerfile                        # Node 25 image + obsidian-headless + bundled vault defaults
├── package.json                      # scripts and dependency surface
├── package-lock.json                 # locked npm graph
├── tsconfig.json                     # strict native TypeScript config
├── vitest.config.ts                  # Vitest config; forks for module isolation
├── biome.json                        # formatter/linter config
├── docs/
├── src/
│   ├── index.ts                      # bootstrap: sync, defaults, settings, stores, primitives, WhatsApp, schedules
│   ├── errors.ts                     # compact user-facing error formatting
│   ├── pipeline/                     # one turn from inbound message to model loop/report
│   │   ├── index.ts                  # top-level turn handler: auth/setup, parse, config, persist, execute
│   │   ├── message.ts                # STT/doc/link parsing, /commands, @agent routing, !override extraction
│   │   ├── media.ts                  # speech-to-text, text-to-speech, docs, images
│   │   ├── agents.ts                 # agent frontmatter schema, prompt sections, registry, aliases, defaults
│   │   ├── overrides.ts              # overrides.yml registry and TurnConfig merge
│   │   ├── context.ts                # variables, tools, toolsets, provider tools, history, message refs
│   │   ├── prompts.ts                # template loading, Handlebars helpers, system/user message rendering
│   │   ├── core.ts                   # chat-completions loop, tool calls, traces, dynamic persistence, reports
│   │   ├── outbound.ts               # reply/react preparation, quotes, dedup keys, trace persistence
│   │   ├── dispatch.ts               # run an agent from schedules, timers, persistence, or another agent
│   │   ├── persistence.ts            # dynamic self-rescheduling timer creation
│   │   └── reports.ts                # per-run JSON reports and optional vault Markdown mirrors
│   ├── primitives/                   # auto-discovered extension surface
│   │   ├── commands/                 # deterministic WhatsApp commands; bypass the LLM
│   │   ├── variables/                # prompt namespaces available as {{key.*}}
│   │   │   ├── index.ts              # Variable type, loader, loaded-variable registry
│   │   │   ├── time.ts               # localized date/time
│   │   │   ├── media.ts              # current turn media/document/image context
│   │   │   ├── tasks.ts              # task-oriented vault context
│   │   │   ├── dispatch.ts           # dispatch/timer objective context
│   │   │   ├── schedule.ts           # frontmatter schedule metadata
│   │   │   ├── config.ts             # effective agent/config facts
│   │   │   ├── snippets.ts           # loads Klaus/snippets/*.md after base variables
│   │   │   └── trigger.ts            # message/schedule/timer/dispatch trigger context
│   │   └── tools/                    # model-callable tools and lazy-loaded tool groups
│   │       ├── index.ts              # ToolDefinition, ToolsetDefinition, registries, loader, load_<toolset>
│   │       ├── reply.ts              # send WhatsApp replies or collect inline dispatch replies
│   │       ├── react.ts              # react to a WhatsApp message
│   │       ├── conversation.ts       # read conversation/history context
│   │       ├── skill.ts              # load declared vault skills on demand
│   │       ├── provider.ts           # OpenRouter/provider tool pass-through definitions
│   │       ├── math.ts               # pure calculation helper
│   │       ├── image.ts              # image generation tool
│   │       └── sets/                 # grouped tools hidden behind load_<name> until needed
│   └── infra/                        # boundaries around config, state, vault, WhatsApp, sync
│       ├── config.ts                 # strict settings schema, live settings object, model/provider resolution
│       ├── logger.ts                 # text/json process logging
│       ├── runtime.ts                # filesystem helpers used across runtime modules
│       ├── simulation.ts             # !simulate overlay for fake external/stateful effects
│       ├── store/                    # flat-file durable state under {dataDir}
│       ├── vault/                    # Obsidian vault access, sync, defaults, markdown helpers
│       └── whatsapp/                 # Baileys transport and first-login flow
├── vault/                            # first-run template copied into runtime {vault}/Klaus/
└── test/                             # Vitest coverage, mostly mirroring src/
```

## Turn Flow

Inbound WhatsApp turns follow this path:

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

Scheduled, timer, persistence, and inline-dispatch runs skip inbound parsing and enter through `pipeline/dispatch.ts`, then converge on `pipeline/core.ts`. Frontmatter schedules render the agent's `# Message` at run time with `{{schedule.*}}` metadata.

## Startup Flow

At startup, Klaus:

1. Logs in to Obsidian Sync.
2. Mirrors the remote vault.
3. Copies bundled `vault/` defaults only if `{vault}/Klaus/` does not exist.
4. Loads strict runtime settings.
5. Starts continuous Obsidian Sync.
6. Loads stores, tools, toolsets, agents, variables, commands, skills, templates, overrides, schedules, and timers.
7. Starts WhatsApp login or connects an existing session.

The repo `vault/` folder is only a first-run template. Once runtime `{vault}/Klaus/` exists, that folder is user-owned synced state. Do not merge repo defaults into it or overwrite user edits.

## Extension Pattern

Drop a file, export the right shape, restart:

- `src/primitives/commands/*.ts` for `/commands`
- `src/primitives/variables/*.ts` for prompt namespaces
- `src/primitives/tools/*.ts` for standalone tools
- `src/primitives/tools/sets/*.ts` for lazy toolsets

Vault-level files hot-reload and do not need a restart.
