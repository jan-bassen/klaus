# Reference

This page is the compact list of Klaus knobs. For explanations and examples, use [manual.md](manual.md) and [recipes.md](recipes.md).

## Runtime Files

| Path | Hot-reloads | Purpose |
| --- | --- | --- |
| `{vault}/Klaus/agents/*.md` | yes | Agent frontmatter and prompt bodies. |
| `{vault}/Klaus/snippets/*.md` | yes | Prompt fragments exposed as `{{snippets.<name>}}`. |
| `{vault}/Klaus/skills/*.md` | yes | On-demand Markdown references for `skill_get`. |
| `{vault}/Klaus/templates/*.md` | yes | User, agent, help, error, welcome, and report rendering. |
| `{vault}/Klaus/overrides.yml` | yes | `!preset` definitions. |
| `{vault}/Klaus/settings.yml` | yes | Strict runtime settings. |
| `{vault}/Klaus/reports/` | n/a | Optional Markdown report mirror. |
| `{dataDir}/logs/` | n/a | JSON run reports. |
| `{dataDir}/history/` | n/a | Conversation JSONL. |
| `{dataDir}/schedules.json` | n/a | Recurring schedule store. |
| `{dataDir}/timers.json` | n/a | One-shot timer store. |

## Agent Frontmatter

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Canonical route name, used as `@name`. Required. |
| `aliases` | string array | Extra route names, such as `@d`. |
| `tools` | string array | Always-visible local tools. |
| `toolsets` | string array | Lazy groups exposed through `load_<name>`. |
| `providerTools` | string array | Server-side provider tools, currently `web_search` and `web_fetch`. |
| `skills` | string array | Skill filenames this agent may load with `skill_get`. |
| `provider` | string | Provider key from `settings.yml`. |
| `modelTier` | `small`, `medium`, `large` | Model tier for this agent. |
| `voice` | `on`, `auto`, `off` | Voice reply behavior. |
| `temp` | `cold`, `default`, `hot` | Temperature preset. |
| `topP` | `creative`, `default`, `rigid` | Top-p preset. |
| `reasoningEffort` | `low`, `default`, `high` | Reasoning effort preset. |
| `stepLimit` | number | Per-turn model/tool step cap. |
| `historyLimit` | number | Number of prior history rows to include. |
| `historyScope` | `full`, `agent` | Include full chat history or only this agent's rows. |
| `showTrace` | boolean | Show compact tool trace rows in future history. |
| `report` | boolean | Emit run reports for this agent. |
| `vaultAccess` | string array | Per-agent vault permissions, formatted as `path:permission`. |
| `persistenceMode` | `static`, `dynamic` | Make the agent persistent. |
| `persistenceSchedule` | cron string | Required for static persistence. |
| `persistencePrompt` | string | Required for static persistence. |
| `persistenceOverrides` | string array | Optional override names for static persistence. |
| `persistenceHint` | string | Required for dynamic persistence. |

Agent defaults come from `settings.agentDefaults`. Per-message overrides win over both.

## Voice Modes

| Mode | Effect |
| --- | --- |
| `auto` | Text by default. The reply tool may still send voice if the model requests it. |
| `on` | Sets `forceVoice` for the turn unless suppressed. |
| `off` | Sets `suppressVoice` for the turn unless forced. |

`!voice` clears `suppressVoice` for the turn. `!text` suppresses voice for the turn.

## Persistence

Static persistence:

```yaml
persistenceMode: static
persistenceSchedule: "0 8 * * *"
persistencePrompt: "Morning check-in."
persistenceOverrides: [voice]
```

Dynamic persistence:

```yaml
persistenceMode: dynamic
persistenceHint: "Schedule the next run based on the user's last commitment."
```

Dynamic persistence forces a final `persist` tool call with:

| Field | Meaning |
| --- | --- |
| `nextRun` | ISO datetime or duration like `30m`, `6h`, `2d`. |
| `prompt` | Objective for the next run. |
| `overrides` | Optional override names for the next run. |

`nextRun` is clamped by `settings.persistence.minNextRun` and `settings.persistence.maxNextRun`.

## Overrides File

`{vault}/Klaus/overrides.yml` maps names to aliases, descriptions, and TurnConfig fragments.

```yaml
deep:
  aliases: [d]
  description: Use the large model with high reasoning.
  overrides:
    modelTier: large
    reasoningEffort: high
```

Supported override fields:

| Field | Type |
| --- | --- |
| `provider` | string |
| `modelTier` | `small`, `medium`, `large` |
| `forceVoice` | boolean |
| `suppressVoice` | boolean |
| `temperaturePreset` | `cold`, `hot` |
| `topPPreset` | `creative`, `rigid` |
| `reasoningEffort` | `low`, `high` |
| `stepLimit` | number |
| `historyLimit` | number |
| `historyScope` | `full`, `agent` |
| `showTrace` | boolean |
| `report` | boolean |
| `vault` | map of path to `none`, `read`, or `full` |
| `skipHistory` | boolean |
| `ghost` | boolean |
| `fast` | boolean |
| `simulate` | boolean |
| `toolChoice` | `none`, `required` |

## Bundled Overrides

| Name | Aliases | Effect |
| --- | --- | --- |
| `voice` | `v` | Force voice. |
| `text` | `txt` | Suppress voice. |
| `clean` | `cl` | Skip history. |
| `ghost` | `g` | Ghost turn and skip history. |
| `simulate` | `sim` | Dry-run side effects. |
| `report` | `rp` | Enable report. |
| `no-report` | `nr` | Disable report. |
| `small` | `s` | Small model tier. |
| `medium` | `m` | Medium model tier. |
| `large` | `l` | Large model tier. |
| `claude` | none | Claude provider. |
| `openai` | `chatgpt`, `gpt` | OpenAI provider. |
| `gemini` | none | Gemini provider. |
| `qwen` | none | Qwen provider. |
| `deepseek` | none | DeepSeek provider. |
| `cold` | `c` | Low temperature. |
| `hot` | `h` | High temperature. |
| `creative` | `cr` | High top-p. |
| `rigid` | `r` | Low top-p. |
| `no-tools` | `nt` | Disable tools. |
| `low` | `lo` | Low reasoning effort. |
| `high` | `hi` | High reasoning effort. |
| `fast` | `f` | Fast inference flag. |

## Commands

| Command | Aliases | Args | Purpose |
| --- | --- | --- | --- |
| `/help` | `/?` | `[section]` | Show live settings, agents, overrides, and commands. |
| `/default` | none | `<agent>` | Set the default agent. |
| `/model` | `/m` | `[small|medium|large]` | Show or set model tier for the default agent. |
| `/provider` | `/p` | `[provider]` | Show or set provider for the default agent. |
| `/voice` | `/v` | `[on|off|auto]` | Show or set voice mode for the default agent. |
| `/schedules` | `/s` | none | List schedules and timers. |
| `/break` | `/b` | none | Insert a context break. |
| `/retry` | `/r` | none | Re-run the last failed turn. |
| `/image` | `/img` | `<prompt>` | Generate an image. |

## Built-In Tools

Always-visible tools:

| Tool | Purpose |
| --- | --- |
| `reply` | Send a WhatsApp reply or collect an inline dispatch reply. |
| `react` | React to a WhatsApp message. |
| `conversation` | Read conversation/history context. |
| `skill_get` | Load one declared skill. |
| `math` | Pure calculation helper. |
| `image_generate` | Generate an image. |

Toolsets:

| Toolset | Loader | Tools |
| --- | --- | --- |
| `vault` | `load_vault` | `vault_read`, `vault_search`, `vault_list`, `vault_write`, `vault_append`, `vault_backlinks`, `vault_move`, `vault_delete`, `vault_patch`, `vault_tags`, `vault_links`, `vault_outline` |
| `dispatch` | `load_dispatch` | `dispatch`, `dispatch_schedule`, `dispatch_list`, `dispatch_cancel` |
| `files` | `load_files` | `files_upload`, `files_download`, `files_read`, `files_list`, `files_delete` |

Provider tools:

| Tool | Meaning |
| --- | --- |
| `web_search` | OpenRouter server-side web search. |
| `web_fetch` | OpenRouter server-side web fetch. |

## Variables

Variables are available to agent prompts and templates.

| Namespace | Meaning |
| --- | --- |
| `{{time.*}}` | Localized date and time. |
| `{{media.*}}` | Current turn voice, image, document, and attachment context. |
| `{{tasks.*}}` | Active schedules and timers. |
| `{{config.*}}` | Effective agent and turn config facts. |
| `{{dispatch.*}}` | Dispatch trigger prompt and context. |
| `{{trigger.*}}` | Message, schedule, timer, or dispatch trigger facts. |
| `{{snippets.*}}` | Compiled Markdown snippets from `{vault}/Klaus/snippets/*.md`. |

## Settings Sections

`{vault}/Klaus/settings.yml` is strict. Klaus validates it but does not fill missing fields.

| Section | Purpose |
| --- | --- |
| `basics` | Locale, timezone, allowed chat. |
| `agent` | Default agent, step limits, retries, history lookback. |
| `agentDefaults` | Default model, voice, sampling, history, reports, vault access. |
| `defaultProvider` | Active provider key. |
| `endpoints` | OpenAI-compatible endpoints and API key env names. |
| `providers` | Provider model IDs for small, medium, and large tiers. |
| `sampling` | Normalized sampling presets. |
| `media` | Voice, image, and document parsing/generation settings. |
| `whatsapp` | Self-mode, labels, send delays, retries, media limits, presence. |
| `vault` | Watcher, list limits, folder defaults, internal permissions. |
| `persistence` | Dynamic persistence timing clamps. |
| `reports` | JSON/Markdown report behavior. |
| `sync` | Obsidian Sync supervisor settings. |

The repo `vault/settings.yml` is only the first-run template. Runtime reads the user's `{vault}/Klaus/settings.yml` directly.
