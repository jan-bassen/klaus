---
name: klaus-authoring
description: Reference for writing and editing Klaus configuration files — agent frontmatter and prompt bodies, snippets, templates, and overrides.yml. Read this before creating or changing any file in Klaus/agents/, Klaus/snippets/, Klaus/templates/, or Klaus/overrides.yml.
---

# Klaus Authoring Skill

How to write the user-owned files that shape Klaus' behavior. All of these hot-reload: a save in Obsidian takes effect on the next turn, no restart needed.

## Agent Files

An agent is a Markdown file at `Klaus/agents/<name>.md`: YAML frontmatter on top, prompt body below. The frontmatter schema is strict — unknown keys are rejected and the agent fails to load, so a typo breaks loudly instead of being silently ignored.

### Frontmatter fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | — | Required. Canonical registry key. |
| `aliases` | string[] | `[]` | Extra names that route to this agent (`@alias`). |
| `tools` | string[] | `[]` | Non-core function tools, live from the first step. |
| `toolsets` | string[] | `[]` | Lazy tool groups behind a `load_<set>` meta-tool. |
| `serverTools` | string[] | `[]` | Provider-side tools (e.g. `web_search`, `web_fetch`). |
| `skills` | string[] | `[]` | Skills this agent may load via `read_skill`. |
| `provider` | string | global default | Provider key from `settings.providers`. |
| `modelTier` | `small`/`medium`/`large` | global default | Model size for the provider. |
| `voice` | `on`/`auto`/`off` | `auto` | Voice-reply behavior. |
| `temp` | `cold`/`default`/`hot` | `default` | Temperature preset. |
| `topP` | `creative`/`default`/`rigid` | `default` | Top-p preset. |
| `reasoningEffort` | `low`/`default`/`high` | `default` | Reasoning effort hint. |
| `stepLimit` | number | `settings.agent.maxSteps` | Max model steps per run. |
| `historyLimit` | number | global default | Messages of history to include. |
| `historyScope` | `full`/`agent` | `full` | `agent` keeps only this agent's own exchanges. |
| `showTools` | boolean | `true` | Names-only tool summary in history rows. |
| `report` | boolean | `true` | Write a per-turn report. |
| `vaultAccess` | string[] | `[]` | Path-scoped permissions, see below. |
| `persist` | boolean | `false` | Reschedule itself after every run. Requires `persistHint`. |
| `persistHint` | string | — | Instruction for choosing the next run. |
| `persistOverrides` | string[] | `[]` | Override presets applied to rescheduled runs. |
| `schedules` | object[] | `[]` | Cron entries: `{ pattern, label?, overrides? }`. |

Notes:

- Reply tools (`send_message`, `set_reaction`, `send_image`, `return_result`, `end_turn`) come from the invocation context, never from frontmatter.
- Put tools the agent reaches for almost every turn in `tools`; reserve `toolsets` for occasional groups, since loading one costs an extra step.
- Delegated or persistent workers rarely need the full chat: prefer `historyScope: agent` and a low `historyLimit`.
- An agent that declares `schedules` but has no `# Message` section fails to load.

### Prompt body

The body splits on `# System` and `# Message` headings (case-insensitive). With no headings, the whole body is the system prompt.

- `# System` is the stable prompt, compiled as a Handlebars template against the variable namespace (`{{time.date}}`, `{{snippets.personality}}`, ...).
- `# Message` is the synthetic user message for runs without an inbound message: scheduled runs render `{{schedule.*}}`, dispatched runs render `{{dispatch.prompt}}`.

Keep `# System` byte-stable: providers cache identical prompt prefixes, so interpolating a volatile value (live timestamp, counter) into `# System` busts the cache every run. Put changing context in `# Message`.

### Vault access

`vaultAccess` entries are `"path:permission"` with permission `none`, `read`, or `full`. The longest matching path prefix wins, `"*"` is the wildcard fallback, and **no match means denied** (fail-closed). The agent's list is merged over the global `agentDefaults.vaultAccess` baseline. Start broad (`"*:read"`) and subtract with `none`; an empty or too-narrow list leaves the agent blind to the whole vault.

## Snippets

Snippets are `.md` fragments in `Klaus/snippets/`, referenced in prompts as `{{snippets.<name>}}` (filename without extension). Each compiles through Handlebars against the full variable namespace. Snippets do **not** expand other snippets — compose them at the agent level. Keep each snippet to one responsibility so agents can mix and match.

## Templates

Files in `Klaus/templates/` wrap pipeline output; they are not agent personality. The required set: `message-user`, `message-agent`, `history-user`, `history-agent`, `persistence`, `report`, `welcome`, `help`, `error`. They are Handlebars partials — edit content freely, but keep the variables they reference intact.

## Overrides

`Klaus/overrides.yml` defines `!preset` words the user can prefix onto a message for one-turn config changes (model tier, provider, voice, sampling, reporting). Overrides set turn config only; they never carry prompt content. Each preset is a named map of the same behavior fields agents declare in frontmatter.

## Author Notes

In agents, snippets, and templates, HTML comments (`<!-- ... -->`) are author notes for humans and are stripped before rendering. Visible prose should only be instructions the model should actually receive. Use a short leading comment in each file to record its scope and when to edit it.
