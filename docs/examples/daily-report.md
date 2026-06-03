# Example 4 — Daily report

> **Series:** 4 of 5 · **Depth:** intermediate+ · **Touches code:** lightly — a
> small variable, on top of schedules and server tools

Everything so far has happened because *you* sent a message. This example flips
that: an agent that wakes itself up every morning, researches the web on the topics
you care about, and writes a digest to your vault — all with no inbound WhatsApp
message at all. It's the canonical lesson on **self-running, outbound work**.

## What you'll learn

- [`schedules`](../vault/agents.md#persistence-and-schedules): cron entries that
  fire an agent, and the `# Message` body a fired run renders.
- [Server tools](../codebase/primitives.md#server-tools) — `web_search` and
  `web_fetch` run on OpenRouter's side, and their citations come back into the
  report automatically.
- The [`schedule` and `trigger` variables](../codebase/primitives.md#variables), so
  the prompt knows it's a scheduled run and why.
- Producing a digest note, and where the per-turn [report](../vault/reports.md) fits
  alongside it.

## Before you start

Do [example 3](language-coach.md) first — you'll reuse the variable pattern and the
restart workflow without re-deriving them. Check that `web_search` is available for
your provider; it's an OpenRouter server tool, so your provider config needs to
support it.

## Step 1 — The topics to brief on (code)

You could hard-code the topics in the prompt, but then changing them is an agent
edit. Instead, keep them in a note you can edit freely and surface them with a tiny
variable — the same mechanism as example 3, so this stays short.

Create `Brief/topics.md`:

```markdown
- the Svelte and SolidJS release notes
- major news on EU AI regulation
- my city's weather for the day
```

Then `src/primitives/variables/topics.ts`:

```ts
import path from "node:path";
import { readText } from "../../infra/runtime.ts";
import { vaultRoot } from "../../infra/vault/tools.ts";
import type { Variable } from "./index.ts";

/** The user's morning-brief topics, one per line. */
export const topicsVariable: Variable = {
  key: "topics",
  description: "Topics for the morning brief",
  async run() {
    const text = await readText(
      path.join(vaultRoot(), "Brief", "topics.md"),
    ).catch(() => "");
    const list = text
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
    return { list };
  },
};
```

Restart picks it up, and now `{{topics.list}}` is available to any prompt.

## Step 2 — The self-running agent

Create `{vault}/Klaus/agents/brief.md`:

```markdown
---
name: brief
aliases: [br]
modelTier: large
serverTools: [web_search, web_fetch]
toolsets: [vault]
vaultAccess:
  - "*:read"
  - "Brief:full"
schedules:
  - pattern: "0 7 * * *"
    label: morning
---
# System
You write the user a concise morning brief. Research with web search, prefer
primary sources, and never pad — if there's nothing worth saying on a topic, say
so in a line. Cite what you used.

# Message
Good morning. It's {{time.weekday}}, {{time.date}}, and this is the
{{schedule.label}} brief (triggered by {{trigger}}).

Research these topics and write the brief to `Brief/{{time.date}}.md`:
{{topics.list}}

Lead with a one-line summary, then a short section per topic.
```

What's new here:

- **`serverTools: [web_search, web_fetch]`** are always available to this agent and
  execute on OpenRouter's side — the loop never sees a client-side call, and
  citations are read back into the report.
- **`schedules`** fires the agent at 7am every day. Klaus registers and
  de-registers cron entries automatically as you edit the file.
- **`# Message`** is what the scheduled run actually reads — there's no user message
  to respond to. It uses `{{schedule.label}}` and `{{trigger}}` so the agent knows
  the run is the morning cron rather than a person, plus your `{{topics.list}}`. An
  agent that declares `schedules` but has no `# Message` fails to load.
- **`modelTier: large`** because synthesising research is the kind of work a bigger
  model repays.

## Step 3 — Where the output goes

You have two records of every run, and they serve different purposes:

- **The digest note** (`Brief/<date>.md`) is the *product* — what you read over
  coffee. The agent writes it with the vault tools.
- **The [report](../vault/reports.md)** is the *receipt* — what the agent searched,
  what it cited, what it cost. You only open it when something looks off.

If you want to reshape the report itself, it's a [template](../vault/templates.md)
(`templates/report.md`); the digest's shape is just what you ask for in the prompt.

## Step 4 — Restart, then try it

Restart for the new variable, then trigger the schedule rather than waiting until
morning (send the agent a message asking it to run the brief now, or wait for 7am).
Check three things in the report: the search actually ran, the citations are
present, and `Brief/<date>.md` landed with a section per topic. Confirm the rendered
`# Message` shows your topics and the right `{{trigger}}`/`{{schedule.label}}`.

## Going further

- Add an evening wrap-up as a second `schedules` entry with its own `label` and
  `overrides`.
- Swap cron for `persist: true` to make the cadence adaptive instead of fixed.
- Have the final step send you the one-line summary over WhatsApp with
  `send_message`.

## What's next

[Example 5 — Expenses tracker](expenses-tracker.md) is the capstone. It brings
everything together and adds the last two primitives: a custom *tool* the model
calls, and a `/command` that skips the model entirely.
