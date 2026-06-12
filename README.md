# Klaus

**A headless personal AI agent for Obsidian and WhatsApp. Minimal, self-hosted, and yours to extend.**

Klaus is a personal assistant you talk to in one ordinary WhatsApp chat. It reads and writes your Obsidian vault, so it can search your notes, log things you tell it, and keep records that are just Markdown files you own. It transcribes your voice notes, looks at images you send, researches the web, and can wake itself up on a schedule to message you a morning brief or a weekly review. There's no app to open and no dashboard — you text it like you'd text a person.

The twist is that you reshape it by editing Markdown. An agent's prompt, model, and permissions are a file in your vault; save it in Obsidian and the change is live on your next message. When something genuinely needs new code — a tool that calls an outside service, a custom command — that's a small TypeScript file and a restart. So Klaus ships as a usable assistant but is really a working harness: the core stays small and exposes the primitive pieces directly, on the bet that personal agents resist one-size-fits-all and that a modern coding agent can build most of what you want on top of a clear local structure. Iteration is the whole point.

The name nods to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the pirate who allegedly walked past his crew after being beheaded, because this stack is headless. Klaus is for when you would rather sail with your own strange little ship.

## What ships in the box

Klaus starts as a basic but usable WhatsApp assistant. Out of the box it can:

- **Chat through WhatsApp** in one chosen conversation, including text replies, reactions, quoted replies, and optional voice-note output.
- **Route work to agents** with `@assistant`, `@research`, `@meta`, and `@dispatch`, each defined as an editable Markdown file in your Obsidian vault.
- **Understand common inputs**: voice notes are transcribed, images and stickers are passed to vision-capable models, and documents are extracted to text.
- **Read and write your Obsidian vault** through scoped tools, so agents can search notes, edit Markdown, create files, and follow wikilinks without a database.
- **Use generic tools**: web search/fetch via OpenRouter server tools, image generation, math, conversation search, file parsing, and handoffs to other agents.
- **Run deterministic commands** like `/model`, `/voice`, `/default`, `/image`, `/schedules`, `/retry`, `/abort`, `/pause`, `/stop`, and `/resume` without spending a model call.
- **Adjust one turn at a time** with `!overrides`, for example a larger model, a voice reply, or a ghost run that stays out of history.
- **Wake itself up** with cron schedules or self-rescheduling timers, useful for briefs, reviews, reminders, and recurring maintenance; timer listings render in your configured timezone.
- **Leave receipts** in `{vault}/Klaus/reports/`, showing the output, reasoning, tool calls, results, nearby runtime logs, rendered prompt, model choice, token use, and error details for failed turns.

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

On first boot Klaus hydrates the vault from Obsidian Sync, seeds `{vault}/Klaus` from the repo's `vault/` template folder (only if it doesn't exist yet), and writes a temporary `{vault}/Klaus/_login/` folder. From then on `{vault}/Klaus` is your live config — you edit it in Obsidian, not the repo copy. Open `instructions.md` there, choose solo or active-chat mode, and scan `qr-code.svg` from WhatsApp → Linked Devices. The setup code and QR are live WhatsApp linking credentials while `_login` exists, and they live in the synced vault until Klaus removes the folder after pairing, so prefer an end-to-end encrypted Obsidian vault and scan from devices you trust. The full install path, including E2EE vaults, self-mode, and fixes for common startup problems, is in [docs/setup.md](docs/setup.md).

To publish the current package version as a Docker Hub image for `linux/amd64/v2`, use:

```bash
npm run publish -- <dockerhub-user>
```

This pushes `<dockerhub-user>/klaus:X.X.X` and `<dockerhub-user>/klaus:latest`.

## How to use it

You talk to Klaus in one ordinary WhatsApp chat, the way you would text a person. There is no app to open or dashboard to log into. In active-chat mode, Klaus authorizes the chat JID, not individual participants; if you bind it to a group, every member of that group can use the configured agents and tools. Use a 1:1 chat or solo mode for a personal vault unless group access is intentional.

Most messages go to your default agent. Prefix a message when you want a different route or one-turn behaviour:

```text
what changed in my project notes?       # default agent
@research compare these two sources     # @name routes to a specific agent
/model large                            # /command runs a model-free action
!voice think this through with me        # !override tweaks one turn
```

That is the whole interface: `@name` routes, `/commands` do exact model-free actions, and `!overrides` change a single reply. Voice notes, images, quoted messages, and documents can be sent in the same chat. The complete manual is in [docs/usage.md](docs/usage.md).

## What you can build

Klaus isn't trying to be one particular assistant — it's the machinery for whichever one you want. The bundled agents are a starting point; the real product is that an assistant, a chat away, has read and write access to the place you keep your life in Markdown, and that you decide everything: what it knows, what it's allowed to touch, when it speaks up, and what it sounds like. The same few primitives — an agent file, a note, a schedule, occasionally a small tool — get pointed at whatever you actually need:

- A **movie log** you message "saw Dune 2 last night, 4/5" and later ask "what did I rate five stars?" — one agent file, ten minutes, no code.
- A **knowledge gardener** that turns things you send it into a connected web of linked, tagged notes instead of a pile.
- A **weekly review** that reads your week's notes every Sunday evening and reflects them back at you.
- A **language coach** that knows which words you're due to review and quizzes you over breakfast.
- A **morning brief** that researches the web on your topics overnight and has a digest waiting in your vault when you wake up.
- A **voice-note expense logger**: say "lunch, 14 euros" walking out of the restaurant, get a filed expense and a monthly summary — this one earns a custom tool and its own `/command`.

Some of these are an evening of editing Markdown, some are a small TypeScript file; none of them are anyone's roadmap but yours. When you want to see how building actually feels, [docs/examples/](docs/examples/) walks five of these from start to finish in rising complexity.

## Make it your own

Klaus is meant to be lived in and reshaped. Almost everything you'd want to change lives as a file in your vault under `{vault}/Klaus/`, and saving that file in Obsidian takes effect on your next message — no restart, no deploy. These are the pieces you compose:

- **Agents** (`agents/*.md`) — a worker's prompt, model, non-core abilities, and permissions in one Markdown file. Reply tools are added from how the agent is invoked, so inline helpers return results while message-triggered agents can send to WhatsApp; every run also gets `end_turn` as an explicit stop control.
- **Snippets** (`snippets/*.md`) — reusable scraps of prompt you drop into agents with `{{snippets.tone}}`. Keep your voice or your bio in one place instead of repeating it.
- **Skills** (`skills/*.md`) — knowledge an agent loads only when it's relevant, so it isn't carried on every turn. A skill can even bring its own tools along when it loads.
- **Tools** — the things an agent can actually *do* mid-reply: send one or more messages, end its turn, read and write your vault, search the web, generate an image, or hand a job to another agent.
- **Schedules** — any agent can run itself on a cron, or reschedule itself after each run, so Klaus comes to you (a morning brief, a weekly review) instead of only answering when asked.

Prompt files can include short HTML comments as author notes; Klaus strips them before rendering, so the bundled defaults can stay easy to edit without leaking scaffolding into the model prompt.

The loop is tight: change a file (or just ask the `@meta` agent to do it for you in chat — *"give the research agent a colder tone"*), send a message, and see the result. When a reply surprises you, open that turn's report under `{vault}/Klaus/reports/`. It starts with the outcome, output, reasoning, tool calls, results, and nearby runtime logs, then keeps the exact prompt the model saw below, which is almost always enough to spot what went wrong.

The first-run defaults are intentionally broad: agents can read your vault by default, except for the `Klaus/` config folder. That makes the assistant useful immediately, but you should add `vaultAccess` deny rules for sensitive folders or tighten `agentDefaults.vaultAccess` when you want stricter boundaries.

When a change genuinely needs new code rather than a vault edit — a tool that calls some outside service, a new `/command` — that's a small TypeScript file plus a restart. [docs/iteration.md](docs/iteration.md) teaches the building blocks and the day-to-day loop in depth, [docs/development.md](docs/development.md) covers extending Klaus in code, and the [worked examples](docs/examples/) are the gentlest way to learn the whole system by doing.

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
