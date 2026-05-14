# Codebase Walkthrough

Klaus is easiest to understand as one tree. The structure is the architecture: startup at `src/index.ts`, turns through `src/pipeline/`, extension points in `src/primitives/`, outside-world boundaries in `src/infra/`, first-run user files in `vault/`, and mirrored tests in `test/`.

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
│   │   ├── agents.ts                 # agent frontmatter schema, registry, aliases, defaults, persistence config
│   │   ├── overrides.ts              # overrides.yml registry and TurnConfig merge
│   │   ├── context.ts                # variables, tools, toolsets, provider tools, history, message refs
│   │   ├── prompts.ts                # template loading, Handlebars helpers, system/user message rendering
│   │   ├── core.ts                   # chat-completions loop, tool calls, traces, dynamic persistence, reports
│   │   ├── outbound.ts               # shared reply/react preparation, quotes, dedup keys, trace persistence
│   │   ├── dispatch.ts               # run an agent from schedules, timers, persistence, or another agent
│   │   ├── persistence.ts            # static cron persistence and dynamic self-rescheduling
│   │   └── reports.ts                # per-run JSON reports and optional vault Markdown mirrors
│   ├── primitives/                   # auto-discovered extension surface
│   │   ├── commands/                 # deterministic WhatsApp commands; bypass the LLM
│   │   │   ├── index.ts              # Command type, registry, parser, loader
│   │   │   ├── help.ts               # dynamic help from loaded settings/agents/commands/overrides
│   │   │   ├── default.ts            # set default agent for the chat
│   │   │   ├── model.ts              # /model and /provider display/update agent frontmatter
│   │   │   ├── voice.ts              # display/update agent voice mode
│   │   │   ├── schedules.ts          # list recurring schedules
│   │   │   ├── break.ts              # hide prior conversation from the next turn
│   │   │   ├── retry.ts              # replay the previous user turn
│   │   │   └── image.ts              # command-level image generation
│   │   ├── variables/                # prompt namespaces available as {{key.*}}
│   │   │   ├── index.ts              # Variable type, loader, loaded-variable registry
│   │   │   ├── time.ts               # localized date/time
│   │   │   ├── user.ts               # user/profile context
│   │   │   ├── media.ts              # current turn media/document/image context
│   │   │   ├── tasks.ts              # task-oriented vault context
│   │   │   ├── dispatch.ts           # dispatch/scheduling context
│   │   │   ├── config.ts             # effective agent/config facts
│   │   │   ├── snippets.ts           # loads Klaus/snippets/*.md after base variables
│   │   │   └── trigger.ts            # message/schedule/timer/dispatch trigger context
│   │   └── tools/                    # model-callable tools and lazy toolsets
│   │       ├── index.ts              # ToolDefinition, ToolsetDefinition, registries, loader, load_<toolset>
│   │       ├── reply.ts              # send WhatsApp replies or collect inline dispatch replies
│   │       ├── react.ts              # react to a WhatsApp message
│   │       ├── conversation.ts       # read conversation/history context
│   │       ├── skill.ts              # load declared vault skills on demand
│   │       ├── provider.ts           # OpenRouter/provider tool pass-through definitions
│   │       ├── math.ts               # pure calculation helper
│   │       ├── image.ts              # image generation tool
│   │       └── sets/                 # lazy-loaded tool groups
│   │           ├── vault.ts          # vault read/search/list/write/append/delete with permissions + simulation
│   │           ├── dispatch.ts       # inline/later/scheduled agent dispatch
│   │           └── files.ts          # file upload/read/list helpers backed by the file store
│   └── infra/                        # boundaries around config, state, vault, WhatsApp, sync
│       ├── config.ts                 # strict settings schema, live settings object, model/provider resolution
│       ├── logger.ts                 # text/json process logging
│       ├── runtime.ts                # filesystem helpers used across runtime modules
│       ├── simulation.ts             # !simulate overlay for fake external/stateful effects
│       ├── store/                    # flat-file durable state under {dataDir}
│       │   ├── index.ts              # shared store helpers
│       │   ├── history.ts            # conversation JSONL, trace entries, breaks, indexes
│       │   ├── report.ts             # one JSON report per run
│       │   ├── files.ts              # file metadata index + blobs
│       │   ├── schedules.ts          # recurring cron jobs and scheduler wiring
│       │   └── timers.ts             # one-shot future runs and timeout wiring
│       ├── vault/                    # Obsidian vault access, sync, defaults, markdown helpers
│       │   ├── defaults.ts           # copy bundled vault defaults once if Klaus/ is missing
│       │   ├── sync.ts               # obsidian-headless login/link/mirror/continuous sync supervisor
│       │   ├── watcher.ts            # hot-reload agents, skills, snippets, templates, overrides, settings
│       │   ├── index.ts              # vault path resolution and permission checks
│       │   ├── tools.ts              # shared vault tool gating/path/simulation helpers
│       │   └── markdown.ts           # frontmatter, headings, wikilinks, section edits
│       └── whatsapp/                 # Baileys transport and first-login flow
│           ├── connection.ts         # socket lifecycle, connection state, JID normalization
│           ├── login.ts              # _login folder, QR SVG, solo checkbox, setup code, cleanup
│           ├── receive.ts            # inbound WhatsApp normalization and handler attachment
│           ├── send.ts               # outbound queue, deduplication, media sends, socket binding
│           └── presence.ts           # composing/recording presence refresh for long turns
├── vault/                            # first-run template copied into runtime {vault}/Klaus/
│   ├── settings.yml                  # complete strict runtime settings template
│   ├── overrides.yml                 # default !preset definitions
│   ├── agents/
│   │   ├── assistant.md              # default user-facing agent
│   │   └── dispatch.md               # default scheduling/delegation agent
│   ├── skills/                         # simplified one-file Markdown skills, not SKILL.md folders
│   │   ├── obsidian-markdown.md      # Obsidian Markdown reference skill
│   │   ├── obsidian-canvas.md        # Canvas reference skill
│   │   ├── obsidian-bases.md         # Bases reference skill
│   │   └── obsidian-bases-functions.md # Bases formula/function reference skill
│   ├── snippets/
│   │   ├── personality.md            # reusable agent personality fragment
│   │   ├── user.md                   # reusable user-context fragment
│   │   ├── vault.md                  # reusable vault-behavior fragment
│   │   ├── architecture.md           # reusable system/architecture fragment
│   │   └── communication.md          # reusable communication-style fragment
│   └── templates/
│       ├── message-user.md           # rendered user turn template
│       ├── message-agent.md          # rendered outbound agent message template
│       ├── help.md                   # /help output template
│       ├── report.md                 # vault Markdown report template
│       ├── error.md                  # user-facing error template
│       └── welcome.md                # setup-complete welcome template
└── test/                             # Vitest coverage, mostly mirroring src/
```

The main message path is:

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

Scheduled, timer, persistence, and inline-dispatch runs skip inbound parsing and enter through `pipeline/dispatch.ts`, then converge on `pipeline/core.ts`.

The most important ownership rule: the repo `vault/` is only a first-run template. Once runtime `{vault}/Klaus/` exists, it is synced user state; do not merge defaults into it or overwrite it.
