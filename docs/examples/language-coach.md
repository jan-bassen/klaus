# Example 3 — Language coach

> **Series:** 3 of 5 · **Depth:** intermediate · **Touches code:** yes — your
> first [custom variable](../codebase/primitives.md#variables) (restart required)

The first two examples never left the vault. Here we cross into `src/` for the
first time, and the reason why is the whole lesson. You want a language coach that
*remembers* — one that knows, at the start of every turn, which words you're due to
review today. That "due today" list has to be computed fresh each turn from your
history. A prompt can't calculate it and you don't want to type it. That's exactly
what a **variable** is for: a slice of context, computed in code, dropped into the
prompt as `{{...}}`.

## What you'll learn

- Writing a [variable primitive](../codebase/primitives.md#variables) in
  `src/primitives/variables/` — a small function that returns a `{{namespace}}` any
  prompt can read.
- The split between **durable state in the vault** (the record of what you've
  learned) and **derived state in code** (today's review queue, computed from it).
- Why derived, changing context belongs in the agent's `# Message`, not `# System`
  — a volatile value in the system prompt busts the provider's prompt cache on
  every turn.
- The workflow shift: code has **no hot-reload**, so this is the first time you
  restart to see a change.

## Before you start

Do [examples 1–2](movie-tracker.md) first for the vault and agent basics. Then read
the top of [development.md](../development.md) — adding a code primitive means
dropping a file in `src/primitives/`, and it only takes effect on a restart. The
tight save-and-text loop from the vault examples gets one step longer here.

## Step 1 — The durable record (vault)

The vault holds the facts; the code derives from them. Create `Language/log.md` as a
simple table — one row per word, with the date you learned it and the date you last
reviewed it:

```markdown
# Language log

| Word | Meaning | Learned | Last reviewed |
| --- | --- | --- | --- |
```

The coach agent will append and update rows here, just like the movie tracker did.
This note is the single source of truth; nothing about your progress lives in code.

## Step 2 — The variable that computes today's queue (code)

Create `src/primitives/variables/review.ts`. It reads the log note, finds the words
that haven't been reviewed recently, and returns them as the `{{review}}`
namespace:

```ts
import path from "node:path";
import { readText } from "../../infra/runtime.ts";
import { vaultRoot } from "../../infra/vault/tools.ts";
import type { Variable } from "./index.ts";

// How many days before a reviewed word is due again. A real feature would lift
// this into settings (see development.md "Adding a setting"); inline here to keep
// the example to one file.
const REVIEW_INTERVAL_DAYS = 3;

/** Words from the language log that are due for review today. */
export const reviewVariable: Variable = {
  key: "review",
  description: "Vocabulary due for review today",
  async run() {
    const text = await readText(
      path.join(vaultRoot(), "Language", "log.md"),
    ).catch(() => "");

    const cutoff = Date.now() - REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    const due: string[] = [];

    for (const line of text.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      // | Word | Meaning | Learned | Last reviewed |
      if (cells.length < 6 || cells[1] === "Word" || cells[1] === "---") continue;
      const word = cells[1];
      const lastReviewed = Date.parse(cells[4]);
      if (Number.isNaN(lastReviewed) || lastReviewed < cutoff) due.push(word);
    }

    return { due, count: due.length };
  },
};
```

The contract is small: a `key` (the namespace) and a `run` that returns its value.
It's auto-discovered at boot — there's no list to register it in. Keep `run` cheap
and side-effect-free, because it runs on every turn before the model is called. Note
the conventions in play: it's fully typed, a missing file is handled by returning
empty rather than throwing, and the one tunable number is flagged for `settings`.

## Step 3 — Wire it into the agent

Create `{vault}/Klaus/agents/coach.md`:

```markdown
---
name: coach
aliases: [lang]
modelTier: medium
toolsets: [vault]
vaultAccess:
  - "*:none"
  - "Language:full"
schedules:
  - pattern: "0 18 * * *"
    label: review
---
# System
You are a patient language coach. When the user learns or asks about a word,
record it in `Language/log.md` (append a row, or update "Last reviewed" to today
when you quiz them on an existing one).

# Message
It's time for a review session ({{schedule.label}}). The user has
{{review.count}} words due today: {{review.due}}. Quiz them on a few, warmly, and
update each word's "Last reviewed" date as they recall it.
```

The important detail is *where* `{{review}}` goes. It changes every turn, so it
lives in `# Message`, the prompt for self-running turns. Keep `# System` byte-stable
— providers cache an identical system prompt across steps and turns for free, and
interpolating a changing value there throws that cache away on every run (the
[caching tip](../vault/agents.md) has the full reasoning).

The `schedules` entry fires the agent at 6pm daily so it comes to you with the day's
review. A file with `schedules` but no `# Message` won't load — a scheduled run
needs something to say.

## Step 4 — Restart, then try it

Because you added code, restart Klaus (`npm run build && npm run dev`, or however
you run it). Then teach it a few words over a session:

```text
@coach "saudade" — a wistful longing. add it
```

Wait for the 6pm review to fire (or trigger it), and check the
[report](../vault/reports.md): the rendered `# Message` should list exactly the
words your variable judged due, proving the code and the prompt are talking to each
other. If `{{review.due}}` is empty when you expected entries, the report's rendered
prompt and your `log.md` rows are the two places to look.

## Going further

- Add a second variable for streaks or totals, surfaced the same way.
- Switch the daily cron for `persist: true` with a `persistHint`, so the coach picks
  its own next review time based on how you did
  ([persistence](../vault/agents.md#persistence-and-schedules)).
- Turn on `voice: on` for pronunciation practice.

## What's next

You've fed computed state into a prompt. [Example 4 — Daily report](daily-report.md)
puts an agent fully on its own clock: it wakes on a schedule, researches the web,
and writes a report back to your vault.
