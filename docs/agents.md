# Agents

An agent is a Markdown file in `{vault}/Klaus/agents/<name>.md`: YAML frontmatter on top, a prompt body below. The frontmatter declares the agent's tools, model, history, voice, and persistence; the body is the prompt, with Handlebars interpolation. Agents hot-reload — edit the file in Obsidian and the next turn uses it.

Agents are resolved and validated in `src/pipeline/agents.ts`. The frontmatter schema is `.strict()`: unknown keys are rejected, so a typo fails loudly rather than being ignored.

## File shape

```yaml
---
name: agentName
aliases: [short]
tools: [send_message, set_reaction]
toolsets: [vault, files, agents]
serverTools: [web_search, web_fetch]
skills: [obsidian-markdown]
provider: openrouter
modelTier: small | medium | large
voice: on | auto | off
temp: cold | default | hot
topP: creative | default | rigid
reasoningEffort: low | default | high
stepLimit: 12
historyLimit: 20
historyScope: full | agent
showTools: true
report: true
vaultAccess:
  - "*:read"
  - "Klaus:none"
persist: true
persistHint: "reschedule based on the user's next workout"
persistOverrides: [voice]
schedules:
  - pattern: "0 8 * * *"
    label: morning
    overrides: [voice]
---
# System
Stable agent instructions, with {{var}} Handlebars interpolation.

# Message
Message used for scheduled / dispatched runs, with {{schedule.label}} or {{dispatch.prompt}}.
```

## Frontmatter fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | — | Required. Canonical registry key. |
| `aliases` | string[] | `[]` | Extra names that route to this agent (`@alias`). |
| `tools` | string[] | `[]` | Function tools active from the first step. |
| `toolsets` | string[] | `[]` | Lazy tool groups, exposed via a `load_<set>` meta-tool. |
| `serverTools` | string[] | `[]` | OpenRouter server tools (e.g. `web_search`), always included. |
| `skills` | string[] | `[]` | Skills this agent may load via `read_skill`. |
| `provider` | string | — | Provider key from `settings.providers`. Falls back to the global default. |
| `modelTier` | `small`/`medium`/`large` | — | Model size for the provider. Falls back to the global default. |
| `voice` | `on`/`auto`/`off` | `auto` | `on` forces voice replies, `off` suppresses, `auto` lets the model decide per message. |
| `temp` | `cold`/`default`/`hot` | `default` | Sampling temperature preset. |
| `topP` | `creative`/`default`/`rigid` | `default` | Top-p preset. |
| `reasoningEffort` | `low`/`default`/`high` | `default` | Reasoning effort hint. |
| `stepLimit` | number | — | Max model steps in the loop. Falls back to `settings.agent.maxSteps`. |
| `historyLimit` | number | — | Messages of history to include. Falls back to the global default. |
| `historyScope` | `full`/`agent` | — | `full` includes the whole chat; `agent` keeps only this agent's own exchanges. |
| `showTools` | boolean | `true` | Add a names-only tool summary to this agent's history rows. |
| `report` | boolean | `true` | Write a per-turn report. |
| `vaultAccess` | string[] | `[]` | Path-scoped permissions, see below. |
| `persist` | boolean | `false` | Reschedule itself after every run. Requires `persistHint`. |
| `persistHint` | string | — | Instruction the agent uses to choose its next run. Required when `persist` is true. |
| `persistOverrides` | string[] | `[]` | Override presets applied to each rescheduled run. |
| `schedules` | object[] | `[]` | Cron entries; each is `{ pattern, label?, overrides? }`. |

The behaviour fields (`provider` through `report`) are also reachable as one-turn `!overrides` and via `/model`, `/provider`, `/voice`. Precedence is global defaults → frontmatter → overrides; see [pipeline.md](pipeline.md#overrides).

> **Tip — `tools` vs `toolsets`.** A `toolset` is lazy: it is hidden behind a `load_<set>` meta-tool, so the first use costs an extra model step to load the group. Put a tool you reach for almost every turn directly in `tools` (live from step one); reserve `toolsets` for groups that are only occasionally needed.

> **Tip — narrow history for side agents.** A delegated or persistent worker rarely needs the whole chat. `historyScope: agent` (or a low `historyLimit`) keeps its context small and cheap and stops unrelated conversation from leaking in. The bundled `dispatch` agent does exactly this.

## Prompt body

The body is split on `# System` and `# Message` headings (case-insensitive). With no headings, the whole body is the system prompt.

- **`# System`** is the stable prompt, compiled as a Handlebars template against the [variable namespace](primitives.md#variables) — e.g. `{{time.date}}`, `{{snippets.personality}}`.
- **`# Message`** is the synthetic user message for runs that have no inbound WhatsApp message (schedules, timers, `run_agent`). Scheduled runs render it with `{{schedule.*}}`; dispatched runs render it with `{{dispatch.prompt}}`.

> **Tip — keep `# System` stable for caching.** The system prompt is re-sent on every step of the loop, and providers cache identical prompt prefixes automatically — so a byte-stable `# System` is reused across steps *and* turns at no cost. Interpolating volatile values (a live timestamp, a per-turn counter) into `# System` busts that cache on every run; put changing context in `# Message` or rely on the variable namespace only where the value is genuinely stable.

A file that declares `schedules` but has no `# Message` fails to load — a scheduled agent needs something to say when it fires.

## Routing and the default agent

Agents are indexed by name and by every alias. A `@name` at the start of a message routes to that agent for the turn; otherwise the chat's default agent runs. The default is `settings.basics.defaultAgent`, overridable per chat with `/default`. Agents are lazy-loaded from disk on first use.

## Vault access

`vaultAccess` is a list of `"path:permission"` entries. Permission is `none`, `read`, or `full`. The longest matching path prefix wins, with `"*"` as the wildcard fallback; **no match means denied** (fail-closed). The agent's map is merged over the global `agentDefaults.vaultAccess` baseline.

```yaml
vaultAccess:
  - "*:read"        # read anything by default
  - "Private:none"  # except the Private folder
  - "Klaus:full"    # full control of the Klaus config folder
```

This is the per-agent layer; there is also a global scope gate in `settings.vault.scopes` that no agent can escape. Details in [infra.md](infra.md#vault).

> **Tip — seed a baseline, then carve down.** Because no match means denied, an agent with an empty or too-narrow `vaultAccess` silently can't read anything. Start from a broad baseline (`"*:read"`, or the `agentDefaults` baseline you inherit) and *subtract* with `none`/narrower paths, rather than building the list up from nothing and wondering why the agent is blind.

## Persistence and schedules

Two independent ways an agent runs without a fresh message:

- **`schedules`** — cron entries that fire on their `pattern` and run the agent with its `# Message`. Klaus registers and de-registers these automatically as you edit the file.
- **`persist: true`** — after every run, a forced `persist` tool call returns `{ nextRun, prompt, overrides? }` and Klaus schedules a one-shot timer for the next run, forming an unbreakable chain. `nextRun` is an ISO timestamp or a compact duration (`30m`, `6h`, `2d`), clamped to the `settings.persistence` min/max.

Both converge on the same execution path as a normal turn. The mechanics live in [pipeline.md](pipeline.md#persistence-and-schedules).

## Bundled agents

The first-run template ships four agents:

| Agent | Alias | Role |
| --- | --- | --- |
| `assistant` | — | General daily driver. Full toolsets, web search, several skills, medium tier. |
| `research` | `@r` | Read-oriented web and vault investigation. Read-only vault access, cold/rigid sampling, large tier. |
| `meta` | `@m` | Edits the user-owned `Klaus/` config folder. `Klaus:full` vault access, everything else denied. |
| `dispatch` | `@d` | Generic delegated worker invoked by `run_agent`. Minimal tools, agent-scoped history. |

These are ordinary files — copy, edit, or delete them. `@meta` can edit them for you from WhatsApp.

---
---
---
---
---
## [Continue to Pipeline](pipeline.md)
