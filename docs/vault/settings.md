# Settings

Runtime settings live in `{vault}/Klaus/settings.yml`. One-turn config presets live in `{vault}/Klaus/overrides.yml`.

The repo `vault/settings.yml` is only the first-run template. Runtime reads the user's synced file directly after startup vault sync.

For the TypeScript side of commands, variables, tools, and toolsets, see [../codebase/primitives.md](../codebase/primitives.md).

## Runtime Settings

`settings.yml` is strict. Klaus validates it but does not fill missing fields.

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

If code adds a tunable setting, add it to both `vault/settings.yml` and `src/infra/config.ts`. Do not use Zod `.default()` fallbacks for runtime settings.

`media.voice.tts.voiceId` is the global ElevenLabs TTS voice. Individual
agents can set `voiceId` in frontmatter to override it for that agent.

`whatsapp.presenceRefreshMs` is the interval for re-sending WhatsApp
`composing`/`recording` updates while Klaus is working on an inbound message.
WhatsApp clients can clear the bubble quickly, so the bundled template uses a
short interval.

## Overrides

Overrides are `!preset` words in messages. They are parsed out of the message and merged into `TurnConfig` on top of settings and agent frontmatter.

```yaml
deep:
  aliases: [d]
  description: Use the large model with high reasoning.
  overrides:
    modelTier: large
    reasoningEffort: high
```

Use an override anywhere after the optional route:

```text
@assistant !deep compare these two ideas
@assistant !simulate organize the Inbox note
```

Overrides are for behavior, not prompt content. Use [prompts.md](prompts.md) for reusable prompt material.

## Override Fields

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

`!simulate` implies `ghost` and `skipHistory`. It writes reports but does not send real WhatsApp replies or persist real state changes.
