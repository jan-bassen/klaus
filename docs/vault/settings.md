# Settings

Runtime settings live in `{vault}/Klaus/settings.yml`. This one file holds the knobs that aren't per-agent: locale and timezone, loop limits, model routing, sampling values, media options, and the global vault scope gate.

The file is parsed once through a strict Zod schema in `config.ts`. There are no `.default()` fallbacks anywhere in that schema, which is a deliberate choice: a missing or misnamed field fails startup loudly rather than quietly falling back to something you didn't intend. If a deploy refuses to boot after an upgrade, a renamed setting is the usual cause, and the log will name it.

The repo's `vault/settings.yml` is only the first-run template. At runtime Klaus reads your synced copy and never merges new defaults into it. When you want a setting that a newer version added, copy that one field across rather than overwriting your whole file.

## The settings groups

| Group | Covers |
| --- | --- |
| `basics` | `locale`, `timezone`, `allowedChat`. |
| `agent` | Loop limits: `maxSteps`, `timeout`, `retries`, `maxChainDepth`, `lookbackDays`, `maxReasoningChars`. |
| `agentDefaults` | Per-agent defaults: model tier, voice, sampling presets, history, `showTools`, `report`, baseline `vaultAccess`. |
| `defaultProvider` / `providers` / `endpoints` | Model routing (see below). |
| `sampling` | The temperature and top-p values behind the `cold`/`hot`/`creative`/`rigid` presets. |
| `media` | TTS, STT, vision max size, image generation, document OCR and limits. |
| `whatsapp` | `selfMode`, system label, send delay and retries, download limits, presence refresh. |
| `vault` | Watcher debounce, list caps, and `scopes` (the global path allowlist). |
| `persistence` | `minNextRun` / `maxNextRun` / `defaultNextRun` for reschedules. |
| `sync` | Obsidian sync shutdown timeout, file types, restart backoff, first-sync gate. |

`agentDefaults` is worth a second look, because it sets the floor that every agent inherits before its own frontmatter applies. Raising the default model tier or widening the baseline `vaultAccess` here changes every agent at once.

## Live and mutable

The exported `settings` object is live: hot-reload and command-driven edits (`/model`, `/provider`, `/voice`) rebuild it in place via property descriptors, so existing imports keep working without a restart. `allowedChat` resolves from `basics.allowedChat` first, then the `ALLOWED_CHAT_ID` env var.

If a hot-reloaded `settings.yml` fails validation, Klaus keeps the last valid config and warns the chat instead of crashing, so a typo in Obsidian won't take the agent down.

## Model resolution

`resolveModel(provider, tier)` walks `providers[provider]` → its `endpoint` → `endpoints[...]` → the API key named by that endpoint's `apiKeyEnv`. It is fail-closed: an unknown provider, an unknown endpoint, or a missing key throws. The return is `{ baseURL, apiKey, modelId, tempScale }`, where `tempScale` is the provider's native temperature scale.

At startup Klaus checks that the default provider's key env is present, so a misconfigured provider is caught immediately rather than on the first turn. Image generation resolves the same way through `resolveImageModel()`.

To point Klaus at a different model or a different OpenAI-compatible endpoint, edit `providers`/`endpoints` here and set the matching `apiKeyEnv` in your `.env`. The [setup](../setup.md) guide covers the environment side.

---

**Related:** [agents](agents.md) · [infra](../codebase/infra.md) · [setup](../setup.md) · [development](../development.md)
