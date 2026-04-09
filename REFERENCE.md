# Reference

Complete reference of all Klaus primitives. Keep this file in sync when adding or changing commands, flags, variables, tools, toolsets, modes, or settings.

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
| `/voice` | `/v` | Show or set voice mode for the default agent (`auto`/`on`/`off`/`fixed`) |
| `/accept` | `/a` | Show or set auto-accept mode for the default agent (`on`/`off`) |
| `/help` | `/?` | Show commands, agents, flags, vars, and vault overview; optional section filter |
| `/break` | `/b` | Insert a context break — fresh start from here |

---

## Flags

Flags start with `!` and override pipeline/agent behavior for the current message. Stripped before reaching the agent. Defined in `src/core/flags.ts`.

### Output

| Flag | Aliases | Effect |
|------|---------|--------|
| `!voice` | `!v` | Force voice reply (TTS) |
| `!ghost` | `!g` | Ephemeral call — no persistence, no history |

### Model

| Flag | Aliases | Effect |
|------|---------|--------|
| `!small` | `!s` | Use small-tier model |
| `!medium` | `!m` | Use medium-tier model |
| `!large` | `!l` | Use large-tier model |

### Provider

| Flag | Aliases | Effect |
|------|---------|--------|
| `!claude` | — | Use Claude for this turn |
| `!chatgpt` | — | Use ChatGPT for this turn |
| `!gemini` | — | Use Gemini for this turn |

### Randomness

| Flag | Aliases | Effect |
|------|---------|--------|
| `!cold` | `!c` | Low temperature (deterministic) |
| `!hot` | `!h` | High temperature (creative) |
| `!creative` | `!cr` | High topP (diverse sampling) |
| `!rigid` | `!r` | Low topP (focused sampling) |

### Inference

| Flag | Aliases | Effect |
|------|---------|--------|
| `!low` | `!lo` | Low reasoning effort |
| `!high` | `!hi` | High reasoning effort |
| `!fast` | `!f` | Fast inference mode (provider-dependent) |

### Context

| Flag | Aliases | Effect |
|------|---------|--------|
| `!clean` | `!cl` | Call without conversation history |
| `!accept` | `!a` | Auto-accept confirmation prompts |
| `!no-tools` | `!nt` | Disable all tools except reply |
| `!use-tools` | `!ut` | Force tool use (model must call a tool) |

---

## Context Variables

Dynamic content injected into prompts. System prompts use `{{var}}`, user messages use `$var`. Both support params: `{{var?key=val}}` / `$var?key=val`. Defined in `src/context/`.

| Variable | Priority | Params | Description |
|----------|----------|--------|-------------|
| `snippets` | -1 | — | Loads `Klaus/snippets/*.md` + `user.md` as template vars (scope-aware) |
| `date` | -1 | — | Current date (locale-aware) |
| `time` | -1 | — | Current time (locale-aware) |
| `weekday` | -1 | — | Day of the week |
| `active_tasks` | 4 | `limit=N` | Running async jobs and pending timers |
| `dispatch_context` | -1 | — | Dispatch caller and objective (injected when invoked via `dispatch.agent`) |
| `modes` | -1 | — | Active agent modes (voice, accept, provider) |

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
| `vault.write` | Create or overwrite a note | |
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

File management (upload, download, list, delete). Meta-tool: `use_files`.

| Tool | Description | Confirmation |
|------|-------------|:---:|
| `files.upload` | Upload a file (base64-encoded content) | |
| `files.download` | Download a file by UUID or partial filename | |
| `files.list` | List files with optional name filter | |
| `files.delete` | Delete a file | Yes |

---

## Modes

Persistent agent-level defaults set in frontmatter. Per-message flags always take precedence. Defined in `src/core/modes.ts`.

### voiceMode

Controls TTS output on replies. Set via `/voice <mode>` or agent frontmatter.

| Value | Behavior |
|-------|----------|
| `auto` (default) | Agent decides; no voice unless `!voice` flag or voice input |
| `on` | Always voice reply |
| `off` | Never voice reply (unless `!voice` flag) |
| `fixed` | Voice reply when content exceeds `tts.fixedVoiceThreshold` characters (default: 200) |

Prompt vars: `isVoiceAuto`, `isVoiceOn`, `isVoiceOff`, `isVoiceFixed`.

### acceptMode

Controls confirmation gating. Set via `/accept <mode>` or agent frontmatter.

| Value | Behavior |
|-------|----------|
| `off` (default) | Tools requiring confirmation need user approval (reaction) |
| `on` | All confirmations auto-approved |

### provider

Preferred LLM provider. Set in agent frontmatter or via `/model <provider>`.

Falls back to `providers.active` in settings.yml if not set on the agent. Overridden by `!claude`/`!chatgpt`/`!gemini` flags.

---

## Settings

User-facing configuration in `Klaus/settings.yml`. Hot-reloaded with Zod validation. All fields optional — schema defaults apply. Defined in `src/core/settings-loader.ts`.

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
| `vision` | — | Model ID for vision tier |
| `temperature` | — | Default temperature |
| `coldTemperature` | `0` | Temperature for `!cold` flag |
| `hotTemperature` | `1` | Temperature for `!hot` flag |
| `topP` | — | Default topP |
| `creativeTopP` | `0.95` | topP for `!creative` flag |
| `rigidTopP` | `0.1` | topP for `!rigid` flag |

### context

Token budgets and conversation history limits.

| Field | Default | Description |
|-------|---------|-------------|
| `totalTokens` | `100000` | Total token budget |
| `conversationTokens` | `20000` | Budget for conversation history |
| `activeTasksTokens` | `5000` | Budget for task context |
| `defaultConversationLimit` | `20` | Max messages in history |
| `charsPerToken` | `4` | Token estimation ratio |
| `maxReasoningChars` | `2000` | Cap extended reasoning in context |
| `maxToolResultChars` | `2000` | Cap tool output in context |
| `traceDepth` | `3` | Recent turns with full traces shown |
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
| `fixedVoiceThreshold` | `200` | Character threshold for `fixed` voice mode |

### stt

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `"scribe_v1"` | ElevenLabs STT model |
| `timeoutMs` | `30000` | STT timeout |
| `agentTriggers` | `["hey", "at", "an", "to", "dear"]` | Phrases triggering agent routing from voice |
| `flagTriggers` | `["flagged with", "tagged with", "flags", ...]` | Phrases triggering flag parsing from voice |

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

### whatsapp

| Field | Default | Description |
|-------|---------|-------------|
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

## Precedence

Resolution order for all overridable behavior:

```
Per-message flags  (highest)
    ↓
Agent frontmatter modes
    ↓
Settings defaults (settings.yml)
    ↓
Schema defaults   (lowest)
```
