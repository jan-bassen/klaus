# Klaus

**Klaus is a headless personal AI agent for tinkerers written in TypeScript.**

It is built for people who want their assistant minimal, self-hosted, and close to the metal: Markdown agents, readable files, Obsidian as memory, WhatsApp as the interface, and Docker as the engine room. The name is a nod to the infamous [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), who allegedly walked past his crew after being beheaded; this stack is headless too.

If you're looking for a simpler and more complete setup, projects like [Hermes Agent](https://github.com/NousResearch/hermes-agent) or [OpenClaw](https://github.com/openclaw/openclaw) may be a calmer harbor. Klaus is for when you would rather sail your own strange little ship.

## Quick Start

Prerequisites:

- Docker
- An Obsidian Sync account
- A WhatsApp account to link as a device
- An OpenRouter API key, unless you reconfigure every provider endpoint

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

Build and run the local image:

```bash
docker build -t klaus .

docker run -d --restart unless-stopped \
  --name klaus \
  --env-file .env \
  -v klaus-vault:/app/vault \
  -v klaus-data:/app/data \
  klaus
```

On first boot, Klaus hydrates `/app/vault` from Obsidian Sync, creates `/app/vault/Klaus` if it is missing, and generates a temporary login folder:

```text
{vault}/Klaus/_login/
```

Open `{vault}/Klaus/_login/instructions.md` first. It explains the two setup modes:

- **Solo mode**: Klaus runs on the WhatsApp account you are linking. Tick the solo checkbox before scanning the QR.
- **Active chat mode**: Klaus listens to another chat. Leave the checkbox unticked, scan the QR, then send the generated six-digit setup code from the chat Klaus should listen to.

The QR itself is written to `{vault}/Klaus/_login/qr-code.svg`. Scan it from WhatsApp -> Linked Devices. When setup completes, Klaus writes the right `basics.allowedChat` and `whatsapp.selfMode` settings for you, sends the welcome message, and removes `_login`.

For the full install path, self-mode, E2EE vaults, and troubleshooting, see [docs/setup-guide.md](docs/setup-guide.md).

## Use It

Route to an agent with `@name`:

```text
@assistant what changed in my project notes?
@dispatch remind me tomorrow morning to pack the charger
```

Use commands when you want deterministic behavior instead of an LLM turn:

```text
/help
/default assistant
/model large
/provider openai
/voice off
/break
/retry
```

Use `!overrides` anywhere in a message to tweak a single turn:

```text
@assistant !large !voice think through this plan with me
@assistant !simulate clean up the inbox note
@assistant !clean answer without using our chat history
```

Voice notes are transcribed, images are sent as vision input, common document formats are parsed to text, and quoted messages can carry their original media through the turn.

## Shape

The runtime is deliberately flat:

- `src/index.ts` boots sync, stores, tools, agents, variables, commands, WhatsApp, schedules, and timers.
- `src/pipeline/` owns the per-turn flow: auth, parse, config, persistence, context, prompt rendering, model loop, reports.
- `src/primitives/` holds extension points: commands, variables, tools, toolsets.
- `src/infra/` wraps external systems and durable state: config, vault, stores, WhatsApp, sync, logging.
- `vault/` is the first-run template copied into a new `{vault}/Klaus/` folder.

The deeper map is in [docs/codebase-overview.md](docs/codebase-overview.md).

## Tinker

Most everyday iteration happens in Obsidian:

- Agents live in `{vault}/Klaus/agents/*.md`.
- Snippets live in `{vault}/Klaus/snippets/*.md`.
- Skills live in `{vault}/Klaus/skills/*.md` as simplified single-file Markdown references.
- Overrides live in `{vault}/Klaus/overrides.yml`.
- Settings live in `{vault}/Klaus/settings.yml`.
- Reports can mirror into `{vault}/Klaus/reports/`.

Those files hot-reload. Edit, save, message again.

Code-level primitives are just as direct, but they need a restart:

- Add a command in `src/primitives/commands/`.
- Add a variable in `src/primitives/variables/`.
- Add a tool or toolset in `src/primitives/tools/`.
- Add focused Vitest coverage under matching paths in `test/`.

Start with [docs/iterate-in-obsidian.md](docs/iterate-in-obsidian.md) for vault recipes and [docs/iterate-in-code.md](docs/iterate-in-code.md) for TypeScript extension points.

## Develop

Local development uses Node 25 and npm:

```bash
npm run typecheck
npm run test
npm run test:watch
npx biome check --write .
npm run build
```
