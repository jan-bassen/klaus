# Klaus

**A headless personal AI agent template for Obsidian and WhatsApp — minimal, self-hosted, and yours to extend.**

Klaus is less a finished assistant than a working harness for building one. The core pieces are already wired up — WhatsApp intake, agent routing, prompts, tools, variables, commands, schedules, timers, vault reads and writes, reports, and flat-file storage — and everything interesting is meant to come from your own ideas. Copy the repo and start tinkering.

The bet behind it: personal agents resist one-size-fits-all. Everyone wants different workflows, privacy boundaries, tones, schedules, and notes. So Klaus keeps the core small, exposes the primitive pieces directly, and trusts that a modern coding agent can build most features on top of a clear local structure. Iteration is the whole point. The full picture is in [docs/architecture.md](docs/architecture.md).

The name nods to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the pirate who allegedly walked past his crew after being beheaded, because this stack is headless. Klaus is for when you would rather sail with your own strange little ship.

## Quick Start

You need Docker, an Obsidian Sync account, a WhatsApp account to link as a device, and an OpenRouter API key (unless you change the provider settings).

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
  -v klaus-vault:/vault \
  -v klaus-data:/data \
  klaus
```

On first boot Klaus hydrates the vault from Obsidian Sync, creates `{vault}/Klaus`, and writes a temporary `{vault}/Klaus/_login/` folder. Open `instructions.md` there, choose solo or active-chat mode, and scan `qr-code.svg` from WhatsApp → Linked Devices.

The full install path — E2EE vaults, self-mode, and fixes for common startup problems — is in [docs/setup.md](docs/setup.md).

## Usage

Talk to Klaus in the one chat it listens to. Unprefixed messages go to the default agent; `@name` routes to a specific one; `/commands` make deterministic changes; `!overrides` tweak a single turn:

```text
what changed in my project notes?
@research compare these sources with my notes
/model large
!voice think through this plan with me
```

Voice notes, images, and documents are all accepted. The full operating manual — routing, every command, overrides, `/next`, and voice — is in [docs/usage.md](docs/usage.md).

## Iteration

Most changes happen in Obsidian and hot-reload: agents (`Klaus/agents/*.md`), snippets, skills, templates, `settings.yml`, and `overrides.yml`. Tools, variables, and commands are added in code and need a restart.

When the model behaves strangely, read the run report at `{vault}/Klaus/reports/`: it has the rendered prompt, history, variables, tool calls, results, and errors for that turn. The reporting and authoring loop is covered in [docs/pipeline.md](docs/pipeline.md#reports).

## Development

Local development uses Node 25 and npm:

```bash
npm run typecheck
npm run test
npx biome check --write .
npm run build
```

Conventions, tests, and how to add behaviour are in [AGENTS.md](AGENTS.md).

## Docs

1. [Setup](docs/setup.md) — clone to a running container.
2. [Architecture](docs/architecture.md) — the map: three code zones and the turn flow.
3. [Usage](docs/usage.md) — talking to Klaus over WhatsApp.
4. [Agents](docs/agents.md) — agent files, frontmatter, schedules, persistence.
5. [Pipeline](docs/pipeline.md) — the turn lifecycle, templates, overrides, reports.
6. [Primitives](docs/primitives.md) — tools, commands, variables, snippets, skills.
7. [Infra](docs/infra.md) — settings, vault and sync, WhatsApp, stores.
