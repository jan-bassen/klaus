# Klaus

A lean, self-hosted personal AI agent: **WhatsApp → TypeScript → Obsidian vault**. *Klaus* is named after [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the pirate who allegedly walked past his crew after being beheaded — because this stack is *headless*. Personal hobby project.

**It is:** a single Docker container that routes WhatsApp messages to agents you define as `.md` files in your Obsidian vault. Edit a prompt, save, message — live.

**It isn't:** a multi-user assistant, a customer-facing bot, a rich UI, or a general-purpose framework. It's opinionated and tuned for one user.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node 25 + native TypeScript (strict) |
| LLM | Custom loop · any OpenAI-compatible endpoint (default: OpenRouter) |
| STT / TTS | ElevenLabs |
| WhatsApp | Baileys (unofficial multi-device) |
| Knowledge | Obsidian vault (notes, wikilinks, frontmatter) |
| Storage | JSONL + JSON flat files |
| Hosting | Docker (`janbassen1/klaus`) |

## Quick start

Prereqs: Docker, an Anthropic API key, an Obsidian Sync subscription (the container bundles `obsidian-headless` and keeps your vault in sync).

```bash
git clone <repo-url> && cd klaus
cp .env.example .env    # fill in OPENROUTER_API_KEY, OBSIDIAN_*, etc.

docker run -d --restart unless-stopped \
  --env-file .env \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  -p 3000:3000 \
  janbassen1/klaus:latest
```

`.env` must include `OBSIDIAN_EMAIL`, `OBSIDIAN_PASSWORD`, and `OBSIDIAN_VAULT_NAME` (the remote vault to sync). `OBSIDIAN_MFA` and `OBSIDIAN_E2EE_PASSWORD` are optional — set the latter if your vault is end-to-end encrypted.

1. On first start, Klaus logs into Obsidian Sync, links `/app/vault` to the remote vault, then writes a WhatsApp QR to `{vault}/Klaus/_login/qr-code.svg`. Scan it from WhatsApp → Linked Devices.
2. Send any message to the paired number. Klaus is in **setup mode** and replies with your chat ID.
3. Add `allowedChatId: "<id>"` to `{vault}/Klaus/settings.yml` — hot-reloaded, no restart.

If MFA isn't accepted via `OBSIDIAN_MFA` (Obsidian Sync may not honour it on every login), seed the token interactively once:

```bash
docker run --rm -it -v klaus-data:/app/data janbassen1/klaus:latest \
  ob --config-dir /app/data/obsidian-headless login
```

### Self-mode (single number)

Set `whatsapp.selfMode: true` in `settings.yml`. Klaus runs on your own number — you message the "Note to Self" chat and Klaus replies there. Outbound messages are prefixed with `[AgentName]:` so you can tell them apart from your own text.

## Usage

### @agent routing

`@name` at the start of a message routes to a specific agent:

```
@dispatch summarise my inbox
@fitness plan tomorrow's session
```

Default agent per chat is settable with `/default <name>`.

### /commands

Bypass the LLM entirely:

- `/status`, `/tasks`, `/help`
- `/default <agent>` — set the default agent for this chat
- `/model [small|medium|large]` — show or switch model tier
- `/provider [claude|openai|gemini|...]` — show or switch provider
- `/voice on|off|auto` — toggle agent frontmatter flags
- `/break` — hide prior conversation from the next turn (fresh context)
- `/retry` — re-run the last turn with the same input
- `/reports [agent] [limit]` — recent per-turn reports

### !overrides

`!word` anywhere in a message tweaks pipeline/agent behavior for that turn. Presets live in `Klaus/overrides.yml` (hot-reloaded). Built-ins include:

| Override | Effect |
|---|---|
| `!voice` (`!v`) | Guaranteed TTS reply |
| `!clean` (`!cl`) | Skip conversation history |
| `!small` / `!medium` / `!large` (`!s`/`!m`/`!l`) | Model tier |
| `!claude` / `!openai` / `!gemini` / `!qwen` / `!deepseek` | Provider |
| `!cold` / `!hot` (`!c`/`!h`) | Temperature preset |
| `!creative` / `!rigid` (`!cr`/`!r`) | topP preset |
| `!low` / `!high` (`!lo`/`!hi`) | Reasoning effort |
| `!fast` (`!f`) | Fast inference |
| `!no-tools` / `!use-tools` (`!nt`/`!ut`) | Tool choice |
| `!ghost` (`!g`) | Ephemeral, no persistence |
| `!simulate` (`!sim`) | Dry-run — fake external/stateful tools, no real side effects |

Combine freely: `@fitness !voice !large plan tomorrow's session`.

### Media

Voice notes are transcribed (STT). Images are sent to the model as vision input. Documents (PDF, Word, Excel, PowerPoint) are parsed to text via `@llamaindex/liteparse`. Quoted messages carry their original media through.

## Architecture

Every WhatsApp message goes through a fixed pipeline:

1. **Auth** — allowlist (fail-closed)
2. **Parse** — STT, doc extract, web-link fetch, voice transcript rewrite, `/command`, `@agent`, `!overrides`
3. **Resolve agent + config** — agent frontmatter merged with overrides into a `TurnConfig`
4. **Persist** — append to day-partitioned conversation JSONL
5. **Execute** — assemble context (variables + tools + history), render prompts, run the model loop, emit a structured report

Cron schedules and one-shot timers (including dynamic-persistence reschedules and `dispatch(when: ...)`) also enter at step 5 with a synthesised trigger.

See [CLAUDE.md](CLAUDE.md) for directory layout, per-module concerns, and code conventions.

## Extending

All primitives are auto-discovered — drop a file, export the right shape, restart.

**New agent** — `.md` file in `{vault}/Klaus/agents/` with YAML frontmatter:

```yaml
---
name: research
aliases: [r]
tools: [reply, react]
toolsets: [vault]
providerTools: [web_search]
skills: [obsidian-markdown]
settings:
  provider: claude
  modelTier: large
---
You are a research assistant. {{time.date}} — use web_search + vault.

{{snippets.personality}}
{{snippets.user}}
```

**New tool** — `.ts` file in `src/primitives/tools/` exporting a `ToolDefinition` with a `sideEffect: "external" | "stateful" | "pure"` declaration.

**New variable** — `.ts` file in `src/primitives/variables/` exporting a `Variable`. The `key` becomes a top-level entry in the `{{namespace}}`.

**New command** — `.ts` file in `src/primitives/commands/` exporting a `Command`. Invoked as `/name`.

**New override** — entry in `{vault}/Klaus/overrides.yml`. Hot-reloaded.

**New skill** — `.md` file in `{vault}/Klaus/skills/` with a `description:` frontmatter field. Reference it from an agent's `skills: [...]` list.

Hot-reload covers agent files, skills, snippets, templates, `overrides.yml`, and `settings.yml`. Code-level primitives need a restart.

## Configuration

`.env` — API keys and paths (gitignored):

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required (default endpoint) |
| `ELEVENLABS_API_KEY` | — | For voice notes (STT/TTS) |
| `OBSIDIAN_EMAIL` | — | Required — Obsidian Sync account email |
| `OBSIDIAN_PASSWORD` | — | Required — Obsidian Sync account password |
| `OBSIDIAN_VAULT_NAME` | — | Required — name of the remote vault to sync |
| `OBSIDIAN_MFA` | — | Optional — TOTP code for first login |
| `OBSIDIAN_E2EE_PASSWORD` | — | Optional — vault E2EE password (if enabled) |
| `ALLOWED_CHAT_ID` | — | Fallback — prefer `basics.allowedChatId` in settings.yml |
| `LOG_FORMAT` | `text` | `text` or `json` (NAS log viewers prefer `json`) |

`{vault}/Klaus/settings.yml` — everything tunable (providers, model tiers, media, whatsapp, vault folders + permissions, persistence bounds, reports). Hot-reloaded with Zod validation.

The Docker image runs from `/app`, so those defaults become `/app/vault` and `/app/data`; WhatsApp credentials live at `/app/data/baileys-auth`. Keep two volumes: `klaus-vault` for Obsidian-facing notes and agent config, `klaus-data` for operational state.

## Deploy + operate

```bash
# Pull new version
docker pull janbassen1/klaus:latest && docker restart <container>

# Publish (maintainer)
docker login
docker buildx create --name klaus-builder --driver docker-container --use
npm run publish   # builds linux/amd64, pushes :<version> + :latest

# Logs
docker logs -f <container>

# Wipe (destructive)
docker rm -f <container> && docker volume rm klaus-vault klaus-data
```

---

See [CLAUDE.md](CLAUDE.md) for working in the codebase.
