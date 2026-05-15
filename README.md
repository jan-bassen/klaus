# Klaus

**Klaus is a simple headless personal AI agent for tinkerers that lives in Obsidian and WhatsApp.**

It is built for people who want their assistant minimal, easily configurable and self-hosted. The name is a nod to the infamous [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), who allegedly walked past his crew after being beheaded — because this stack is headless. 

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

For the full install path, E2EE vaults, self-mode, and fixes for common startup problems, use [docs/setup-guide.md](docs/setup-guide.md).

## First Messages

Unprefixed messages go to the chat's default agent:

```text
what changed in my project notes?
```

Route to a specific agent with `@name` or an alias:

```text
@assistant summarize my inbox note
@d remind me tomorrow morning to pack the charger
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
@assistant !large !voice think through this plan with me
@assistant !simulate clean up the inbox note
@assistant !clean answer without using chat history
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

Start with [docs/manual.md](docs/manual.md) for the product model, [docs/recipes.md](docs/recipes.md) for copy-paste changes, and [docs/reference.md](docs/reference.md) for the full list of knobs.

## Docs Map

- [Setup Guide](docs/setup-guide.md): Docker, Obsidian Sync, WhatsApp login, troubleshooting.
- [Manual](docs/manual.md): how routing, agents, snippets, skills, overrides, reports, and automation fit together.
- [Recipes](docs/recipes.md): small edits for common tinkering tasks.
- [Reference](docs/reference.md): frontmatter, settings, commands, tools, variables, and file locations.
- [Development](docs/development.md): adding TypeScript commands, variables, tools, and toolsets.
- [Internals](docs/internals.md): codebase map and runtime flow.

## Develop

Local development uses Node 25 and npm:

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
```
