# Reference

Complete reference of all Klaus primitives. Keep this file in sync when adding or changing commands, overrides, variables, tools, toolsets, or settings.

---

## Commands

Commands start with `/` and bypass the LLM entirely. Defined in `src/commands/`.

| Command | Aliases | Description |
|---------|---------|-------------|
| `/status` | `/s` | Show current agent and active jobs |
| `/tasks` | `/t` | List active jobs, schedules, and timers |
| `/default` | — | Set the default agent for this chat |
| `/model` | `/m` | Show or switch model tier (`small`/`medium`/`large`) or provider (`claude`/`chatgpt`/`gemini`) |
| `/models` | — | List all configured providers and their models |
| `/voice` | `/v` | Show or set voice output for the default agent (`on`/`off`/`auto`) |
| `/accept` | `/a` | Show or set auto-accept for the default agent (`on`/`off`) |
| `/help` | `/?` | Show commands, agents, overrides, vars, and vault overview; optional section filter |
| `/break` | `/b` | Insert a context break — fresh start from here |
| `/retry` | `/r` | Re-run the last turn, or a quoted turn (user msg or bot reply). Uses the default agent with the stored text — media, overrides, and `@agent` routing from the original turn are not reconstructed. |

---

## overrides

overrides start with `!` and override pipeline/agent behavior for the current message. Stripped before reaching the agent. Defined in `Klaus/overrides.yaml` (vault, hot-reloaded). Resolved by `src/pipeline/overrides.ts`.

Agent frontmatter can set any override field directly as a default (e.g. `forceVoice: true`). Per-message `!` overrides always take precedence.

### Output

| override | Aliases | Effect |
|-----------|---------|--------|
| `!voice` | `!v` | Force voice reply (TTS) |
| `!ghost` | `!g` | Ephemeral call — no persistence, no history |

### Model

| override | Aliases | Effect |
|-----------|---------|--------|
| `!small` | `!s` | Use small-tier model |
| `!medium` | `!m` | Use medium-tier model |
| `!large` | `!l` | Use large-tier model |

### Provider

| override | Aliases | Effect |
|-----------|---------|--------|
| `!claude` | — | Use Claude for this turn |
| `!chatgpt` | — | Use ChatGPT for this turn |
| `!gemini` | — | Use Gemini for this turn |

### Randomness

| override | Aliases | Effect |
|-----------|---------|--------|
| `!cold` | `!c` | Low temperature (deterministic) |
| `!hot` | `!h` | High temperature (creative) |
| `!creative` | `!cr` | High topP (diverse sampling) |
| `!rigid` | `!r` | Low topP (focused sampling) |

### Inference

| override | Aliases | Effect |
|-----------|---------|--------|
| `!low` | `!lo` | Low reasoning effort |
| `!high` | `!hi` | High reasoning effort |
| `!fast` | `!f` | Fast inference mode (provider-dependent) |

### Context

| override | Aliases | Effect |
|-----------|---------|--------|
| `!clean` | `!cl` | Call without conversation history |
| `!accept` | `!a` | Auto-accept confirmation prompts |
| `!no-tools` | `!nt` | Disable all tools except reply |
| `!use-tools` | `!ut` | Force tool use (model must call a tool) |

### override fields in agent frontmatter

Any field from the `TurnConfig` type can be set directly in agent YAML frontmatter as a default:

```yaml
---
name: reader
forceVoice: true
autoAccept: true
provider: gemini
modelTier: large
temperaturePreset: cold
---
```

Resolution: agent frontmatter defaults → per-message `!override` → final.

### Adding custom overrides

Add entries to `Klaus/overrides.yaml`:

```yaml
mypreset:
  aliases: [mp]
  description: My custom preset
  overrides: { modelTier: large, temperaturePreset: cold }
```

The file is hot-reloaded — no restart needed.

---

## Variables

Dynamic content injected into prompts and user message templates. All templates see the same unified nested namespace. Reference with `{{var.path}}` in Handlebars templates, `$var.path` in user-typed message text. Defined in `src/variables/`.

| Key | Shape | Description |
|-----|-------|-------------|
| `time` | `{ date, time, weekday }` | Current date, time, and weekday (locale/timezone-aware) |
| `media` | `{ kind, doc, image, voice, quoted }` | Attached media for the current message. `kind` is `"doc" \| "image" \| "voice" \| null`; only one of `doc`/`image`/`voice` is populated accordingly. |
| `tasks` | `{ active: [{ kind, objective, runAt? }] }` | Running async jobs and pending timers |
| `dispatch` | `{ caller, objective, hint, mode, hasMessage } \| null` | Set when the agent was invoked via `dispatch.agent` (or scheduled/persistent tick); `null` for direct `@agent` calls |
| `config` | `TurnConfig` + `{ isVoiceOn, isVoiceOff, isVoiceAuto }` | Effective turn configuration — agent frontmatter defaults merged with per-message overrides. Templates read this without caring about provenance (e.g. `config.forceVoice`, `config.modelTier`, `config.provider`, `config.isVoiceOn`). |
| `snippets` | `{ [name]: compiledText }` | Each `Klaus/snippets/*.md` compiled through Handlebars with the full namespace. `user.md` is excluded — it lives under `user`. |
| `user` | `{ profile }` | User profile loaded from `snippets/user.md` |

### Handlebars helpers

Use these to shape values in templates:

- `{{trunc value max [suffix="…"]}}` — cap a string at `max` chars, appending `…` (or a custom suffix). The only truncation primitive — there is no global budget.
- `{{limit array n}}` — slice an array to its first N elements (useful with `{{#each (limit …)}}`).
- `{{eq a b}}`, `{{ne a b}}`, `{{lt a b}}`, `{{gt a b}}` — comparisons.
- `{{and …}}`, `{{or …}}`, `{{not a}}` — logic.
- `{{default value fallback}}` — fallback when `value` is falsy.
- `{{join array sep}}` — join an array.

### Variable ordering

Variables run in parallel. A variable may opt into a second phase by setting `after: true` on its definition; it then receives the phase-1 namespace via `turn.vars`. `snippets` is the canonical example — it needs the full namespace to compile snippet Handlebars.

---

## Tools

### Standalone tools

Opt-in per agent via `tools:` in frontmatter. Defined in `src/tools/`.

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `reply` | Send a WhatsApp message (text or voice) | `content`, `voice?`, `messageRef?` |
| `react` | React to a message with an emoji | `emoji`, `messageRef?` |
| `conversation` | Search conversation history (text, around message, time range) | `query?`, `around_message_id?`, `after?`, `before?`, `limit?` |
| `skill.get` | Load a reference document by name (scoped to agent's `skills:` list) | `name` (enum) |

### Provider tools

Native LLM capabilities declared via `providerTools:` in frontmatter. Canonical names resolved per provider at runtime. Defined in `src/tools/provider.ts`.

| Canonical name | Claude (anthropic) | ChatGPT (openai) | Gemini (google) |
|---------------|-------------------|------------------|-----------------|
| `web_search` | `webSearch` | `webSearchPreview` | `googleSearch` |
| `code_execution` | `codeExecution` | `codeInterpreter` | `codeExecution` |

Unsupported tools for the active provider are silently skipped.

---

## Toolsets

Lazy-loaded tool groups activated via `toolsets:` in frontmatter. Each registers a `use_<name>` meta-tool; calling it injects the actual tools. Defined in `src/tools/sets/`.

### vault

Obsidian vault operations with folder-level permissions. Meta-tool: `use_vault`.

| Tool | Description | Confirmation |
|------|-------------|:---:|
| `vault.read` | Read a note by relative path | |
| `vault.search` | Full-text search across all markdown notes | |
| `vault.list` | Browse vault directory structure | |
| `vault.write` | Create or override a note | |
| `vault.append` | Append content to a note (optional heading target) | |
| `vault.backlinks` | Find all notes that link to a given note | |
| `vault.move` | Move or rename a note (optional backlink rewrite) | |
| `vault.delete` | Permanently delete a note | Yes |
| `vault.patch` | Replace the body of a specific section by heading | |
| `vault.tags` | Find notes by tag or list all tags | |
| `vault.links` | Extract all outgoing `[[wikilinks]]` from a note | |
| `vault.outline` | Return heading structure with item counts | |

### dispatch

Agent invocation, scheduling, and timers. Meta-tool: `use_dispatch`.

| Tool | Description | Confirmation |
|------|-------------|:---:|
| `dispatch.agent` | Invoke another agent (`async` or `inline` mode) | |
| `dispatch.schedule` | Schedule recurring agent runs (cron pattern) | |
| `dispatch.timer` | Schedule a one-time agent run (ISO datetime or delay string) | |
| `dispatch.list` | List all active schedules and pending timers | |
| `dispatch.cancel` | Cancel a schedule or timer by ID | Yes |

### files

File management (upload, download, read, list, delete). Meta-tool: `use_files`.

| Tool | Description | Confirmation |
|------|-------------|:---:|
| `files.upload` | Upload a file (base64-encoded content) | |
| `files.download` | Download a file by UUID or partial filename (returns base64) | |
| `files.read` | Read a file's text content. Parses PDFs/docx/xlsx/pptx via liteparse (cached); returns text/* files directly | |
| `files.list` | List files with optional name filter | |
| `files.delete` | Delete a file | Yes |

---

## Settings

User-facing configuration in `Klaus/settings.yml`. Hot-reloaded with Zod validation. All fields optional — schema defaults apply. Defined in `src/config/schema.ts`.

### Top-level

| Field | Default | Description |
|-------|---------|-------------|
| `defaultAgent` | `"klaus"` | Agent used when no `@agent` prefix |
| `locale` | `"de-DE"` | Locale for date formatting |
| `timezone` | `"Europe/Berlin"` | Timezone for cron scheduling |

### providers

Provider configuration. Each named entry (claude, chatgpt, gemini) uses the same schema.

| Field | Default | Description |
|-------|---------|-------------|
| `active` | `"claude"` | Default provider name |
| `sdk` | — | SDK identifier: `"anthropic"`, `"openai"`, `"google"` |
| `small` | — | Model ID for small tier |
| `medium` | — | Model ID for medium tier |
| `large` | — | Model ID for large tier |
| `temperature` | — | Default temperature |
| `coldTemperature` | `0` | Temperature for `!cold` override |
| `hotTemperature` | `1` | Temperature for `!hot` override |
| `topP` | — | Default topP |
| `creativeTopP` | `0.95` | topP for `!creative` override |
| `rigidTopP` | `0.1` | topP for `!rigid` override |

### context

Conversation history limits. Per-variable truncation inside prompts is done with `{{trunc …}}` — there is no global token budget.

| Field | Default | Description |
|-------|---------|-------------|
| `conversationChars` | `80000` | Char budget for conversation history included in the model call |
| `defaultConversationLimit` | `20` | Max messages pulled from storage before budget trimming |
| `traceDepth` | `3` | Most recent user turns that keep full tool traces; older turns get compact summaries |
| `conversationLookbackDays` | `7` | How far back to load history |

### rateLimits

| Field | Default | Description |
|-------|---------|-------------|
| `messages.max` | `30` | Max messages per window |
| `messages.windowMs` | `60000` | Message rate window (ms) |
| `modelCalls.max` | `60` | Max LLM calls per window |
| `modelCalls.windowMs` | `60000` | Model call rate window (ms) |

### tts

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `"eleven_multilingual_v2"` | ElevenLabs TTS model |
| `voiceId` | `"Qqi8SzIZjZsatCWjDOp7"` | ElevenLabs voice ID |

### stt

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `"scribe_v1"` | ElevenLabs STT model |
| `timeoutMs` | `30000` | STT timeout |
| `agentTriggers` | `["hey", "at", "an", "to", "dear"]` | Phrases triggering agent routing from voice |

### llm

| Field | Default | Description |
|-------|---------|-------------|
| `timeoutMs` | `120000` | Total timeout for model call |
| `maxSteps` | `10` | Max agentic loop iterations |

### dispatch

| Field | Default | Description |
|-------|---------|-------------|
| `maxChainDepth` | `10` | Depth limit for recursive agent dispatch |

### persistent

| Field | Default | Description |
|-------|---------|-------------|
| `minNextRunMs` | `60000` | Min delay between persistent runs |
| `maxNextRunMs` | `604800000` | Max delay (7 days) |
| `defaultNextRun` | `"1h"` | Fallback delay string |

### retries

| Field | Default | Description |
|-------|---------|-------------|
| `max` | `3` | Max retry attempts |
| `backoffMs` | `1000` | Backoff between retries (ms) |

### send

| Field | Default | Description |
|-------|---------|-------------|
| `interMessageDelayMs` | `1500` | Delay between WhatsApp sends |

### trail

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable trail output to vault |
| `retentionDays` | `3` | Days to keep trail files |

### watcher

| Field | Default | Description |
|-------|---------|-------------|
| `debounceMs` | `1000` | Debounce delay for file hot-reload |

### vision

| Field | Default | Description |
|-------|---------|-------------|
| `maxImageDimension` | `2048` | Downscale images to this max dimension |

### document

| Field | Default | Description |
|-------|---------|-------------|
| `maxChars` | `40000` | Max chars of parsed text kept inline in the user message or returned by `files.read` |
| `ocrEnabled` | `true` | Run OCR (Tesseract.js) on scanned PDFs / image-only pages |

### whatsapp

| Field | Default | Description |
|-------|---------|-------------|
| `selfMode` | `false` | Self-mode: run Klaus on your own WhatsApp number (messages to self) |
| `systemLabel` | `"System"` | Prefix label for non-LLM messages in self-mode (commands, errors, setup) |
| `maxDownloadBytes` | `67108864` | Max media download size (64 MB) |
| `mediaDownloadTimeoutMs` | `30000` | Media download timeout |
| `offlineWindowMs` | `300000` | Time before marking offline (5 min) |
| `maxSeenSize` | `10000` | Dedup cache size |
| `confirmTimeoutMs` | `60000` | Reaction confirmation window |

### vault

Folder-level access control for vault operations.

| Field | Default | Description |
|-------|---------|-------------|
| `folders[].path` | — | Folder relative path |
| `folders[].default` | — | Default permission: `none`, `read`, `append`, `full` |
| `folders[].request` | — | Elevated permission (available via reaction confirmation) |
| `internalPermission.default` | `"read"` | Klaus/ internal folder default permission |
| `internalPermission.request` | — | Klaus/ internal elevated permission |
| `maxListEntries` | `200` | Result limit for vault queries |

---

## HTTP Endpoints

| Endpoint | Response | Description |
|----------|----------|-------------|
| `/healthz` | JSON | Health check — status (`ok`/`degraded`), WhatsApp connection state, version |

---

## Precedence

Resolution order for all overridable behavior:

```
Per-message !overrides  (highest)
    ↓
Agent frontmatter defaults
    ↓
Settings defaults (settings.yml)
    ↓
Schema defaults   (lowest)
```
