# Klaus

**Klaus is a simple headless personal AI agent for tinkerers that lives in Obsidian and WhatsApp.**

It is built for people who want their assistant minimal, easily configurable and self-hosted. The name is a nod to the infamous [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), who allegedly walked past his crew after being beheaded — because this stack is headless. 

The core pieces are already wired up: WhatsApp intake, agent routing, prompts, tools, variables, commands, schedules, timers, vault reads and writes, reports, simulation, and flat-file storage. Anything beyond that is up to you — drop your own ideas straight into those primitives. Just copy the repo and start tinkering.

If you're looking for a simpler and more complete setup, projects like [Hermes Agent](https://github.com/NousResearch/hermes-agent) or [OpenClaw](https://github.com/openclaw/openclaw) may be a calmer harbor. Klaus is for when you would rather sail with your strange little ship.

## Quick Start

You need Docker, Obsidian Sync, a WhatsApp account to link as a device, and an OpenRouter API key unless you change the provider settings.

```bash
git clone https://github.com/jan-bassen/klaus.git
cd klaus
cp .env.example .env
```

Fill in at least:

```dotenv
OPENROUTER_API_KEY=
OBSIDIAN_EMAIL=
OBSIDIAN_PASSWORD=
OBSIDIAN_VAULT_NAME=
```

Build and run:

```bash
docker build -t klaus .

docker run -d --restart unless-stopped \
  --name klaus \
  --env-file .env \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  klaus
```

On first boot, Klaus hydrates `/app/vault` from Obsidian Sync, creates `/app/vault/Klaus` if it is missing, and writes a temporary login folder:

```text
{vault}/Klaus/_login/
```

Open `{vault}/Klaus/_login/instructions.md`, choose solo mode or active chat mode, then scan `{vault}/Klaus/_login/qr-code.svg` from WhatsApp Linked Devices.

For the full install path, E2EE vaults, self-mode, and fixes for common startup problems, use [docs/setup.md](docs/setup.md).

## First Messages

Unprefixed messages go to the chat's default agent:

```text
what changed in my project notes?
```

Route to a specific agent with `@name` or an alias:

```text
@meta always reply in Italian from now on
@m move the daily brief to 7am
```

Use commands for deterministic changes:

```text
/help
/default assistant
/model large
/provider openai
/voice off
/break
/retry
```

Use `!overrides` anywhere after the route to tweak one turn:

```text
!large !voice think through this plan with me
@meta !simulate remove the test agent 
```

Voice notes are transcribed, images become vision input, common documents are parsed to text, and quoted messages can carry their original media through the turn.

## Tinker

Most changes happen in Obsidian and hot-reload:

- Agents: `{vault}/Klaus/agents/*.md`
- Snippets: `{vault}/Klaus/snippets/*.md`
- Skills: `{vault}/Klaus/skills/*.md`
- Overrides: `{vault}/Klaus/overrides.yml`
- Settings: `{vault}/Klaus/settings.yml`
- Templates: `{vault}/Klaus/templates/*.md`

Tools, variables, and commands are also easy to add in code, but require a restart to take effect.

Start with [docs/architecture.md](docs/architecture.md) for the product model, then follow the vault or codebase pages depending on what you want to change.

## Docs Map

- [Setup](docs/setup.md): Docker, Obsidian Sync, WhatsApp login, troubleshooting.
- [Architecture](docs/architecture.md): the main map from WhatsApp to pipeline, tools, vault, stores, and reports.
- [Codebase Pipeline](docs/codebase/pipeline.md): parse, config, context, model loop, dispatch, persistence, reports.
- [Codebase Primitives](docs/codebase/primitives.md): adding TypeScript commands, variables, tools, toolsets, and provider tools.
- [Codebase Infra](docs/codebase/infra.md): config, vault/sync, WhatsApp, stores, simulation, logging.
- [Vault Agents](docs/vault/agents.md): agent files, frontmatter, routing, tools, schedules, persistence, permissions.
- [Vault Prompts](docs/vault/prompts.md): snippets and skills as reusable prompt context.
- [Vault Templates](docs/vault/templates.md): message, help, error, welcome, and report render wrappers.
- [Vault Settings](docs/vault/settings.md): `settings.yml` and `overrides.yml`.
- [Vault Reports](docs/vault/reports.md): JSON reports, Markdown mirrors, simulation, debugging.

## Develop

Local development uses Node 25 and npm:

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
```
