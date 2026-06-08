# Iteration

Klaus is built to be reshaped, and it's arranged so that reshaping it is fast. The interesting features are meant to come from you, and almost none of them require code. What they do require is a feel for two things: the handful of pieces you build out of, and the short loop you run to put them together. This page is about both.

One idea sits underneath all of it, the same one from the README: a message becomes a *turn*, the turn gathers context and abilities from your vault, the model works through the request, and anything lasting is written back to the vault. Every change you make is an adjustment to one of those pieces, and you feel the result on your very next message.

## The loop

Working with Klaus is a cycle, and once it's in your hands the whole thing feels less like configuring software and more like a conversation that slowly teaches itself your preferences.

1. **Pick the piece that fits.** Most changes are one kind of thing: a tweak to an agent, a new snippet, a skill, a schedule. Knowing which is half the work, and the next section is a tour of the options.
2. **Make the smallest version.** Edit one file in Obsidian, or just ask the `@meta` agent to do it for you. Don't build the whole feature at once; get the first slice working.
3. **Try it in the chat.** Send the message that should trigger it.
4. **Read the report if it surprises you.** Every turn records exactly what the model saw and did, so a wrong result is something you can inspect rather than guess at.
5. **Adjust and go again.** Because vault files hot-reload, the gap between an edit and seeing its effect is a single message.

That tightness is the point. Steps 2 and 3 are a save and a text, so you iterate in seconds, not deploys. The rest of this page walks each beat in turn: choosing a piece, making the change, and reading what happened.

## Choosing a piece

Almost everything you'll build is one of the following. They're all files in your vault, none of them need code, and they hot-reload when you save. The skill is learning which one a given idea wants. As a rough intuition: change *how an agent behaves* with an agent edit or a snippet, give it *occasional know-how* with a skill, make it *act on its own* with a schedule, and only give it a *brand-new ability* with a tool, which is the one case that means code.

**Agents** (`{vault}/Klaus/agents/<name>.md`) are the heart of it. An agent is a Markdown file: YAML frontmatter declaring its model, tools, skills, history, and vault permissions, with a prompt underneath for its personality and instructions. You talk to one with `@name`. The template ships `assistant`, `research`, `meta`, and `dispatch` as ordinary files you can copy, edit, or delete. Reach for a new agent when you want a worker with a distinct job, voice, or set of permissions. Detail in [agents](vault/agents.md).

**Snippets** (`snippets/*.md`) are reusable fragments of prompt. Write your tone of voice, or a few facts about yourself, once in a snippet and pull it into any agent with `{{snippets.tone}}`. A snippet is always present in the prompt of an agent that includes it. Reach for one when you catch yourself repeating the same instructions across agents. See [snippets](vault/snippets.md).

**Skills** (`skills/*.md`) are knowledge an agent loads *only when it needs it*. Where a snippet is always in context, a skill stays out of the way until the model decides the moment calls for it, then it's pulled in for the rest of the turn. A skill can also declare its own tools, so reading it grants the agent the abilities that knowledge needs. Reach for a skill for detailed, occasional know-how — how you like expenses logged, the structure of your project notes — that would be wasteful to carry every turn. See [skills](vault/skills.md).

**Tools** are what an agent can *do* during a reply, as opposed to just say. Sending a message is a tool; so are reading and writing your vault, searching the web, generating an image, and handing a job to another agent. The model calls them mid-turn and reacts to what they return, and agents opt into them (and into lazy-loaded *toolsets*) in frontmatter. The built-in set covers most needs. A genuinely new ability is the main reason you'd drop into code, which is where [development](development.md) picks up. See [primitives](codebase/primitives.md).

**Overrides** (`!preset`, defined in `overrides.yml`) tweak a single turn without touching a file. Prefix a message with `!large` for a bigger model just this once, `!voice` for a spoken reply, or `!ghost` to run something without recording it. Reach for an override when the change is for *this message only*. See [overrides](vault/overrides.md).

**Commands** (`/slash`) are deterministic actions that skip the model entirely: switching your default model, listing schedules, stopping background work. They run instantly and never cost a model call. The bundled set is in [usage](usage.md#commands); a new one is a code change.

**Schedules and persistence** let an agent run without you prompting it. A `schedules` entry in an agent's frontmatter fires it on a cron; `persist: true` has the agent choose its own next run after each turn, forming a self-renewing chain. Reach for these when you want Klaus to come to you — a morning brief, a weekly review — rather than wait to be asked. See [agents](vault/agents.md#persistence-and-schedules).

Underneath all of these, **variables** are the `{{...}}` values any prompt, snippet, or template can read: `{{time.date}}`, the current message's media, the agent's pending tasks. You mostly consume them; adding a new one is a code change covered in [development](development.md).

## Making the change

Once you've picked a piece, there are three places a change can happen, and they differ mainly in how fast it lands.

| Surface | What you change there | How fast it takes effect |
| --- | --- | --- |
| **WhatsApp** | Route with `@agent`, run `/commands`, apply one-turn `!overrides` | immediately, that turn |
| **`{vault}/Klaus/`** | Agents, snippets, skills, templates, `settings.yml`, `overrides.yml` | hot-reload, next turn |
| **`src/`** | New tools, commands, variables, or pipeline behaviour | restart |

The rule of thumb: if you're changing *what Klaus knows or how it behaves*, you're editing a vault file and it hot-reloads. If you're adding *a brand-new ability* it doesn't have yet, that's code and a restart. Most days you live entirely in the middle row.

And that middle row is genuinely yours. On first boot Klaus copies the repo's `vault/` template into `{vault}/Klaus/`, and from then on it reads and watches *your* copy. It never merges defaults back in or overwrites your edits, so you can rename agents, rewrite snippets, and delete anything you don't use without it creeping back. Because the vault syncs through Obsidian, you can make these edits from your laptop or your phone, and the change reaches the container on the next sync.

You don't even need Obsidian open, though. The bundled `@meta` agent has write access to the `Klaus/` config folder and nothing else, so you can ask it for changes in plain language:

```text
@meta give the research agent a colder temperature
@m add a snippet called "tone" that keeps replies under three sentences
@meta create an agent "chef" that suggests dinners from my pantry note
```

`@meta` edits the very same files you would, so its changes hot-reload the same way. It's the fastest path for small tweaks, and a good way to learn the file shapes by watching what it writes for you.

## Reading what happened

The habit that pays off most is the fourth step of the loop, and it's worth slowing down on. When Klaus does something you didn't expect, don't theorise about the prompt. Read the one it actually received.

Every turn writes a [report](vault/reports.md) to `{vault}/Klaus/reports/<date>/`, and it starts with the outcome, output, every tool call, and every result. Below that are the fully rendered user message, history transcript, system prompt, and context summary. A snippet that didn't interpolate, a template wrapping text oddly, an agent reading the wrong vault path, a tool that came back with a permission error the model then worked around: all of it is right there in plain text. Most "why did it do that?" questions answer themselves the moment you open the report for the run, and that turns debugging from a guessing game into reading.

## When the loop needs code

You can take this surprisingly far without ever opening the codebase. The one time the loop genuinely needs code is when you want an ability Klaus doesn't have — a tool that calls some outside service, a `/command` for a deterministic action, a variable that feeds fresh data into every prompt. Those live in `src/` and take effect on a restart rather than a hot-reload, so the loop is a little longer, but the rhythm is the same. [Development](development.md) is the guide for that, starting from the mental model of how a turn actually runs.

## Following a worked build

The pieces above are easier to feel than to read about, so the [examples](examples/) are a ladder of full features that put them together one at a time. Start with the [movie tracker](examples/movie-tracker.md) — a first agent that writes to your vault, no code — and climb: a [knowledge tree](examples/knowledge-tree.md) that curates linked notes, a [language coach](examples/language-coach.md) that adds your first custom variable, a [daily report](examples/daily-report.md) on a schedule, and an [expenses tracker](examples/expenses-tracker.md) that ties a custom tool and command together. Each one introduces a single new idea, so they double as the gentlest path into the code.

---

**Related:** [examples](examples/) · [development](development.md) · [agents](vault/agents.md) · [reports](vault/reports.md) · [usage](usage.md)
