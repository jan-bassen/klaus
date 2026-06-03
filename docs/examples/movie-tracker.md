# Example 1 — Movie tracker

> **Series:** 1 of 5 · **Depth:** beginner · **Touches code:** no (vault only)

This is the "hello world" of building a feature in Klaus. You'll make an agent
that keeps a log of films you've watched: message it "saw Dune 2 last night, 4/5"
and it appends a tidy row to a note in your vault; ask it "what did I rate five
stars?" and it reads the note back and tells you. No TypeScript, no restart — one
Markdown file you can write from Obsidian or have `@meta` write for you.

By the end you'll have done the three things every later example builds on:
written an agent, given it tools, and scoped what it's allowed to touch.

## What you'll learn

- The shape of an [agent file](../vault/agents.md): frontmatter on top, prompt
  underneath.
- Handing an agent the [`vault` toolset](../codebase/primitives.md#toolsets) so it
  can read and write notes.
- Scoping [vault access](../vault/agents.md#vault-access) so an agent can only
  touch what it should.
- Routing to an agent with `@name`.

## Before you start

You'll need Klaus running and paired to WhatsApp — that's the [setup](../setup.md)
guide. It helps to have skimmed [how messages are routed](../usage.md), since the
whole feature hinges on `@movies` going to the right agent.

One thing to hold onto: everything here **hot-reloads**. Save the file and your
next message uses the new version. There's no build and no restart — that only
comes later, when an example needs actual code.

## Step 1 — Make the note the agent will own

Decide where the log lives and give it a fixed shape up front. Create
`Media/movies.md` in your vault (the folder is up to you; `Media/` is just what
this guide uses) with a table header and nothing else:

```markdown
# Movies

| Date | Title | Rating | Note |
| --- | --- | --- | --- |
```

The fixed columns matter more than they look. If you tell the agent exactly what
a row is, it appends consistent rows instead of reinventing the format every time
and leaving you with a mess to clean up later.

## Step 2 — Write the agent

An agent is a single Markdown file in `{vault}/Klaus/agents/`. Create
`{vault}/Klaus/agents/movies.md`:

```markdown
---
name: movies
aliases: [mv]
modelTier: small
toolsets: [vault]
vaultAccess:
  - "*:none"
  - "Media:full"
---
# System
You keep the user's movie log at `Media/movies.md`.

When the user tells you about a film they watched, append one row to that note
in exactly this format, using today's date ({{time.date}}):

| {{time.date}} | <title> | <rating>/5 | <short note> |

If they didn't give a rating or a note, leave that cell blank — never invent one.

When the user asks a question about their movies, read the note and answer from
it. Don't guess; if it isn't in the log, say so.
```

A few things worth understanding rather than copying:

- **`toolsets: [vault]`, not `tools`.** The vault tools (read, append, search, and
  the rest) load lazily behind a single `load_vault` meta-tool, which keeps the
  agent's starting context small. The first time the agent needs the vault it
  spends one extra step to load the group — a fine trade for something it doesn't
  use on *every* turn. The full reasoning is the
  [tools-vs-toolsets tip](../vault/agents.md).
- **`vaultAccess` is fail-closed.** No matching rule means *denied*, so the
  `"*:none"` baseline locks everything and `"Media:full"` opens just the one
  folder. The longest matching path wins. This is the habit to build early: give
  an agent exactly the reach its job needs and nothing more.
- **`{{time.date}}` is a [variable](../codebase/primitives.md#variables).** Klaus
  fills it in when it renders the prompt, so the agent always knows what "today"
  is without you telling it.
- **`modelTier: small`** is plenty here. Appending a row and reading a list is not
  hard work; save the big models for the agents that earn them.

That's the whole feature. Save the file.

## Step 3 — Try it

Message your Klaus chat:

```text
@movies watched Sinners last night, 4/5, loved the soundtrack
```

Open `Media/movies.md` and you should see a new row with today's date, the title,
`4/5`, and your note. Now ask it something:

```text
@movies what have I given 5 stars?
```

It should read the note and answer from what's actually there — not from
training-data guesses about films. If you only ever rated *Sinners* a 4, it
should tell you it doesn't have a 5-star entry yet.

If anything surprises you, don't theorise — read the [report](../vault/reports.md)
for that turn in `{vault}/Klaus/reports/`. It shows the fully rendered prompt the
agent received and every tool call it made, so a wrong row or a refused read is
right there in plain text. Getting comfortable opening reports now will pay off in
every later example.

## Going further

- Add a column the agent fills in itself, like genre or who you watched it with,
  by extending the row format in the prompt.
- Make `@movies` the default agent for a dedicated WhatsApp chat with `/default`,
  so you can drop the `@movies` prefix entirely.
- Ask `@meta` to make these edits for you (`@meta add a "genre" column to the
  movies agent`) and watch how it writes the same file you just did.

## What's next

You've built an agent that appends to one flat note. [Example 2 — Knowledge
tree](knowledge-tree.md) takes the vault much further: instead of a single list,
the agent curates a web of *linked* notes — creating, connecting, and tidying
them — which is the real power of putting your knowledge in a vault.
