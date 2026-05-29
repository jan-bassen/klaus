# Settings

Runtime settings live in `{vault}/Klaus/settings.yml`. One-turn config presets live in `{vault}/Klaus/overrides.yml`.

The repo `vault/settings.yml` is only the first-run template. Runtime reads the user's synced file directly after startup vault sync.

For the TypeScript side of commands, variables, tools, and toolsets, see [../codebase/primitives.md](../codebase/primitives.md).

## Runtime Settings

`settings.yml` is strict. Klaus validates it but does not fill missing fields.
Startup fails if the synced file is missing or invalid; live edits after startup keep the
last valid config and send a warning.

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

`media.voice.tts` and `media.voice.stt` use the same named endpoints as the
model providers. The bundled template routes both through OpenRouter: Gemini
Flash TTS for speech output and Voxtral Mini Transcribe for voice-note input.
Voice-note routing and one-turn overrides are explicit: use `/next <prefix>`
before recording, such as `/next @research !large`. `media.voice.tts.responseFormat`
is `pcm` or `mp3`; PCM output is converted from 24 kHz, 16-bit mono PCM to Ogg
Opus before sending so Gemini TTS can be used directly as a WhatsApp voice note.

`whatsapp.presenceRefreshMs` is the interval for re-sending WhatsApp
`composing`/`recording` updates while Klaus is working on an inbound message.
WhatsApp clients can clear the bubble quickly, so the bundled template uses a
short interval. Klaus stops the active presence keeper as soon as a top-level
message is queued, which keeps follow-up persistence/report work from showing a
fresh typing or recording indicator after the visible message.

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
@assistant !ghost inspect this without saving it to history
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
| `showTools` | boolean |
| `report` | boolean |
| `vault` | map of path to `none`, `read`, or `full` |
| `skipHistory` | boolean |
| `ghost` | boolean |
| `fast` | boolean |
| `toolChoice` | `none`, `required` |

## Bundled Overrides

| Name | Aliases | Effect |
| --- | --- | --- |
| `voice` | `v` | Force voice. |
| `text` | `txt` | Suppress voice. |
| `clean` | `cl` | Skip history. |
| `ghost` | `g` | Ghost turn and skip history. |
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
