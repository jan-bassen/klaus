# Klaus

**A headless personal AI agent template for Obsidian and WhatsApp. Minimal, self-hosted, and yours to extend.**

Klaus is less a finished assistant than a working harness for building one. The core pieces are already wired up: WhatsApp intake, agent routing, prompts, tools, variables, commands, schedules, timers, vault reads and writes, reports, and flat-file storage. Everything more interesting is meant to come from your own ideas. Copy the repo and start tinkering.

The bet behind it: personal agents resist one-size-fits-all. Everyone wants different workflows, privacy boundaries, tones, schedules, and notes. So Klaus keeps the core small, exposes the primitive pieces directly, and trusts that a modern coding agent can build most features on top of a clear local structure. Iteration is the whole point.

The name nods to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the pirate who allegedly walked past his crew after being beheaded, because this stack is headless. Klaus is for when you would rather sail with your own strange little ship.

## Getting started

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

On first boot Klaus hydrates the vault from Obsidian Sync, creates `{vault}/Klaus`, and writes a temporary `{vault}/Klaus/_login/` folder. Open `instructions.md` there, choose solo or active-chat mode, and scan `qr-code.svg` from WhatsApp → Linked Devices. The full install path, including E2EE vaults, self-mode, and fixes for common startup problems, is in [docs/setup.md](docs/setup.md).

## How to use it

You talk to Klaus in one ordinary WhatsApp chat, the way you would text a person. Everything happens through messages, there is no app to open or dashboard to log into.

The work inside Klaus is done by **agents**. An agent is just a Markdown file that gives a personality, a model, and a set of abilities to one worker. The template ships four: `assistant` (your daily driver), `research` (read-only web and notes investigation), `meta` (edits Klaus's own configuration for you), and `dispatch` (a generic worker other agents hand jobs to). A plain message goes to your default agent; you reach a specific one by name.

Four small bits of grammar shape a message:

```text
what changed in my project notes?      # plain text → your default agent
@research compare these two sources     # @name routes to a specific agent
/model large                            # /command: a deterministic action, no model call
!voice think this through with me        # !override: tweak just this one turn
```

`@name` picks the agent, `/commands` do exact things instantly (switch model, list schedules, stop everything), and `!overrides` adjust a single reply (use a bigger model, answer as a voice note, leave no trace). Voice notes, images, and documents all work as input too — a voice note is transcribed, an image becomes something the agent can see, a PDF is read in. The complete manual, with every command and override, is in [docs/usage.md](docs/usage.md).

## Make it your own

Klaus is meant to be lived in and reshaped. Almost everything you'd want to change lives as a file in your vault under `{vault}/Klaus/`, and saving that file in Obsidian takes effect on your next message — no restart, no deploy. These are the pieces you compose:

- **Agents** (`agents/*.md`) — a worker's prompt, model, abilities, and permissions in one Markdown file. Edit one to change how it behaves, or copy it to make a new specialist.
- **Snippets** (`snippets/*.md`) — reusable scraps of prompt you drop into agents with `{{snippets.tone}}`. Keep your voice or your bio in one place instead of repeating it.
- **Skills** (`skills/*.md`) — knowledge an agent loads only when it's relevant, so it isn't carried on every turn. A skill can even bring its own tools along when it loads.
- **Tools** — the things an agent can actually *do* mid-reply: send a message, read and write your vault, search the web, generate an image, or hand a job to another agent.
- **Schedules** — any agent can run itself on a cron, or reschedule itself after each run, so Klaus comes to you (a morning brief, a weekly review) instead of only answering when asked.

The loop is tight: change a file (or just ask the `@meta` agent to do it for you in chat — *"give the research agent a colder tone"*), send a message, and see the result. When a reply surprises you, open that turn's report under `{vault}/Klaus/reports/`. It shows the exact prompt the model saw, every tool it called, and what each one returned, which is almost always enough to spot what went wrong.

When a change genuinely needs new code rather than a vault edit — a tool that calls some outside service, a new `/command` — that's a small TypeScript file plus a restart. [docs/iteration.md](docs/iteration.md) teaches the building blocks and the day-to-day loop in depth, [docs/development.md](docs/development.md) covers extending Klaus in code, and [docs/examples/](docs/examples/) is a ladder of five worked builds — from a no-code movie tracker up to an expenses tracker with a custom tool and command — that's the gentlest way to learn the whole system by doing.

## Docs

Start with the guides, then dip into the reference when you need a detail.

**Guides**
1. [Setup](docs/setup.md) — clone to a running container.
2. [Usage](docs/usage.md) — talking to Klaus over WhatsApp.
3. [Iteration](docs/iteration.md) — the loop of making Klaus your own.
4. [Development](docs/development.md) — extending Klaus in code.
5. [Examples](docs/examples/) — a difficulty ladder of five follow-along feature builds, each adding one new idea.

**Reference — your vault** (`{vault}/Klaus/`, hot-reloads)
- [Agents](docs/vault/agents.md) · [Snippets](docs/vault/snippets.md) · [Skills](docs/vault/skills.md) · [Templates](docs/vault/templates.md) · [Overrides](docs/vault/overrides.md) · [Reports](docs/vault/reports.md) · [Settings](docs/vault/settings.md)

**Reference — the codebase** (`src/`, needs a restart)
- [Pipeline](docs/codebase/pipeline.md) · [Primitives](docs/codebase/primitives.md) · [Infra](docs/codebase/infra.md)

Building on top of Klaus with a coding agent? Point it at [AGENTS.md](AGENTS.md).
