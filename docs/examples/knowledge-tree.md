# Example 2 — Knowledge tree

> **Series:** 2 of 5 · **Depth:** beginner+ · **Touches code:** no (vault only)

In [example 1](movie-tracker.md) the agent appended rows to one flat note. That's
useful, but it's not what a vault is *for*. The real payoff of keeping your
knowledge in Markdown is that notes link to each other — so this time you'll build
an agent that curates a connected web of notes instead of a single list. Send it a
loose thought and it finds the right home for it, links it to what's related, and
keeps the structure tidy.

This is the deepest you can go on vault files alone. After this, the examples start
reaching for code.

## What you'll learn

- The rest of the [`vault` toolset](../codebase/primitives.md#toolsets) beyond
  basic reading and appending: `vault_find`'s tag and backlink filters,
  `vault_read`'s outline view, `vault_edit`'s section replace, and `vault_move`.
- Writing a [skill](../vault/skills.md) that captures *your* note-taking
  conventions and loads only when the agent needs it.
- How a skill can carry its own `toolsets`, so reading it both instructs the agent
  and arms it with the tools the job needs.

## Before you start

Do [example 1](movie-tracker.md) first — this assumes you can write and route an
agent and scope its `vaultAccess`, and won't re-explain those.

One decision to make up front: your **conventions**. The agent enforces a system,
it doesn't invent taste. Before you write anything, decide where notes live, when a
new note is warranted versus extending an old one, and how you like to link and
tag. This example uses a `Knowledge/` folder of short, single-idea notes, but the
shape is yours.

## Step 1 — Put your conventions in a skill

A snippet is always in the prompt; a skill is loaded only when the agent decides it
needs it. Note-taking rules are exactly that kind of occasional, detailed knowledge
— wasteful to carry every turn, essential the moment the agent is filing a thought.
So they go in a skill.

Create `{vault}/Klaus/skills/note-conventions.md`:

```markdown
---
toolsets: [vault]
---
# Note-taking conventions

Notes live under `Knowledge/`. Each note is one idea, titled as a short noun
phrase, filename matching the title.

When a new thought arrives:

1. Search `Knowledge/` for an existing note on the same idea before making a new
   one. Prefer extending a note over creating a near-duplicate.
2. If it's genuinely new, create the note with a one-line summary at the top.
3. Link it. Add `[[wikilinks]]` to the two or three most related notes, and add a
   matching link back from each of those so the connection goes both ways.
4. Tag it with one or two `#topic` tags that already exist where possible — check
   the current tags first rather than inventing synonyms.

Keep edits small and surgical. Never rewrite a note wholesale to add one link.
```

Two things to notice. The frontmatter `toolsets: [vault]` means that the instant
the agent reads this skill, the vault tools switch on for the rest of the turn — the
skill bundles the instructions *and* the capability they require. And the body is
just your rules in plain language; tune it freely, it hot-reloads.

## Step 2 — Write the curator agent

Create `{vault}/Klaus/agents/brain.md`:

```markdown
---
name: brain
aliases: [b]
modelTier: medium
skills: [note-conventions]
vaultAccess:
  - "*:none"
  - "Knowledge:full"
---
# System
You curate the user's knowledge base under `Knowledge/`.

When the user sends a thought, an idea, or a link, file it: read your
`note-conventions` skill first, then follow it to find a home, write the note,
connect it, and tag it. Work in small, precise edits.

When the user asks how ideas connect, explore the graph with the vault tools
(backlinks, links, tags, outline) and answer from what's actually linked.
```

The agent starts lean: it lists the skill but doesn't carry it. Its prompt's first
instruction is to *read the skill*, which both pulls in your conventions and (via
the skill's frontmatter) arms the vault toolset. `modelTier: medium` is a step up
from the movie tracker because deciding where a note belongs and how to link it is
real judgement, not just formatting.

## Step 3 — Understand the curation loop

It helps to know which tool does what, because the report will show the agent moving
through these in order:

- **`vault_find`** with a `query` — find whether a note on this idea already
  exists.
- **`vault_read`** — open the candidate home to decide extend-or-create; the
  `view: "outline"` option gives the lay of the land without the full text.
- **`vault_edit`** — make a small, targeted append or section replace instead of
  rewriting the file.
- **`vault_find`** with `linksTo` — see what points back at a note, so connections
  can be made both ways (a note's outgoing links are visible right in its text).
- **`vault_find`** with a `tag` — check existing tags before adding new ones, to
  avoid synonyms.
- **`vault_move`** — relocate or rename a note when the structure shifts.

You don't wire any of this up. You describe the behaviour in the skill and the
agent picks the tools to match.

## Step 4 — Try it

Feed it a few related thoughts across separate messages and watch links form:

```text
@brain CRDTs and operational transform both solve concurrent editing, but CRDTs
push the merge into the data structure itself
```
```text
@brain operational transform needs a central server to order operations
```

Then probe the graph it built:

```text
@brain what connects to my note on CRDTs?
```

It should answer from real `vault_find` backlink output, not a guess. Open your
`Knowledge/` folder and you should see short notes that actually `[[link]]` to one
another. As always, if something lands wrong, the [report](../vault/reports.md) for
the turn shows the rendered prompt (including the skill body once it was read) and
every tool call.

## Going further

- Add a weekly tidy pass — a [schedule](../vault/agents.md#persistence-and-schedules)
  that asks the agent to find orphan notes and link them. (Schedules get their own
  treatment in [example 4](daily-report.md).)
- Write a second skill for a different domain. The agent loads whichever one fits
  the thought in front of it.

## What's next

So far everything has lived in the vault. [Example 3 — Language
coach](language-coach.md) crosses into `src/` for the first time, with a custom
*variable* that computes fresh state and feeds it into the prompt on every turn.
