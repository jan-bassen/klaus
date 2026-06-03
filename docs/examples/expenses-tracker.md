# Example 5 — Expenses tracker

> **Series:** 5 of 5 · **Depth:** advanced · **Touches code:** fully — a custom
> tool *and* a slash command, plus an agent and a schedule

The capstone. This one pulls together everything from the earlier examples and adds
the last two code primitives — a **tool** the model calls mid-reply, and a
**`/command`** that bypasses the model entirely. You'll build an expense tracker
with two ways in: snap a photo of a receipt and Klaus reads it and logs it, or type
`/expense 12.50 lunch` for an instant, model-free entry. On the 1st of each month a
scheduled run totals everything into a report.

The interesting lesson here is *when to use which primitive*. The same feature wants
a command for the deterministic path and a tool for the judgement-call path, and
seeing them side by side makes the distinction concrete.

## What you'll learn

- A [custom tool](../codebase/primitives.md#tools): a Zod `inputSchema`, an
  `execute` that does the work and returns a value the model can act on.
- A [custom command](../codebase/primitives.md#commands): a `/slash` handler that
  runs and ends the turn at **zero model cost**.
- Reading an inbound image via the [`media` variable](../codebase/primitives.md#variables)
  so the agent can interpret a receipt photo.
- Tying it off with a monthly [schedule](../vault/agents.md#persistence-and-schedules)
  — reusing [example 4](daily-report.md)'s pattern, not re-teaching it.

## Before you start

Do [examples 3–4](language-coach.md) first; this assumes you're comfortable adding a
code primitive and restarting, and it spends its words on the tool and command
rather than the basics. The shared helpers it uses — `readText`, `writeData`,
`vaultRoot`, `enqueueMessage` — are the same infra utilities the bundled primitives
use.

## Step 1 — The ledger (vault)

One note, fixed columns, exactly as in [example 1](movie-tracker.md). Create
`Finance/expenses.md`:

```markdown
# Expenses

| Date | Amount | Category | Note |
| --- | --- | --- | --- |
```

Both the command and the tool append to this same file, so the ledger has one shape
no matter which path an entry came in through.

## Step 2 — The quick-entry command (code)

When you already know the amount and category, there's nothing for a model to
decide — so don't pay for one. A command runs, replies, and ends the turn with no
model call. Create `src/primitives/commands/expense.ts`:

```ts
import path from "node:path";
import { settings } from "../../infra/config.ts";
import { readText, writeData } from "../../infra/runtime.ts";
import { vaultRoot } from "../../infra/vault/tools.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

export const expenseCommand: Command = {
  name: "expense",
  aliases: ["ex"],
  params: [{ name: "amount" }, { name: "category" }],
  description: "Log an expense: /expense <amount> <category> [note]",
  async execute(msg: InboundMessage, args: string[]): Promise<void> {
    const [amount, category, ...rest] = args;
    const reply = (content: string) =>
      enqueueMessage({
        chatId: msg.chatId,
        content,
        dedupKey: `${msg.id}:expense`,
        label: settings.whatsapp.systemLabel,
      });

    if (!amount || !category) {
      reply("Usage: /expense <amount> <category> [note]");
      return;
    }

    const file = path.join(vaultRoot(), "Finance", "expenses.md");
    const date = new Date().toISOString().slice(0, 10);
    const row = `| ${date} | ${amount} | ${category} | ${rest.join(" ")} |\n`;

    const existing = await readText(file).catch(() => "");
    await writeData(file, existing + row);
    reply(`Logged ${amount} to ${category}.`);
  },
};
```

The shape is the [`Command` contract](../codebase/primitives.md#commands): a name,
optional aliases and params, and an `execute` that is responsible for its own reply
(there's no model to send one). It writes the row directly with the infra helpers
and confirms. Instant, free, deterministic — the right tool for structured input.

## Step 3 — The receipt-scan tool (code)

A photo of a receipt is the opposite case: the amount and category have to be
*read* and *judged* out of an image. That's a job for the model, and the tool is how
it records what it found. Create `src/primitives/tools/log_expense.ts`:

```ts
import path from "node:path";
import { z } from "zod";
import { readText, writeData } from "../../infra/runtime.ts";
import { vaultRoot } from "../../infra/vault/tools.ts";
import type { ToolDefinition } from "./index.ts";

const schema = z.object({
  amount: z.number().describe("The total amount paid."),
  category: z
    .string()
    .describe("A short category, e.g. groceries, transport, dining."),
  note: z.string().optional().describe("Optional merchant or detail."),
});

export const logExpenseTool: ToolDefinition<typeof schema> = {
  name: "log_expense",
  description:
    "Record one expense in the ledger. Call this once you've determined the " +
    "amount and category, including from a receipt image.",
  inputSchema: schema,
  execute: async ({ amount, category, note }) => {
    const file = path.join(vaultRoot(), "Finance", "expenses.md");
    const date = new Date().toISOString().slice(0, 10);
    const row = `| ${date} | ${amount} | ${category} | ${note ?? ""} |\n`;
    try {
      const existing = await readText(file).catch(() => "");
      await writeData(file, existing + row);
      return { ok: true, logged: { date, amount, category } };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

The `description` and `inputSchema` are the tool's interface to the *model* — write
them as instructions, since they're how it decides when and how to call it. It
returns a clear value on success and `{ error }` on failure rather than throwing, so
a problem feeds back into the loop instead of blowing it up. An agent only gets this
tool if it lists it in frontmatter.

## Step 4 — The agent

The agent interprets the receipt image and calls the tool. Create
`{vault}/Klaus/agents/expenses.md`:

```markdown
---
name: expenses
aliases: [exp]
modelTier: medium
tools: [log_expense]
toolsets: [vault]
vaultAccess:
  - "*:none"
  - "Finance:full"
schedules:
  - pattern: "0 9 1 * *"
    label: monthly
---
# System
You track the user's spending in `Finance/expenses.md`.

When the user sends a receipt image, read the amount and category from it
({{media.kind}} attached) and call `log_expense` with what you find. Confirm what
you logged in one line. If the image is unreadable, ask rather than guess.

# Message
It's the start of the month ({{schedule.label}}). Read `Finance/expenses.md`,
total last month's spending by category, and write a summary to
`Finance/{{time.date}}-summary.md`.
```

`tools: [log_expense]` puts the tool live from the first step (it's used almost
every receipt, so it doesn't belong behind a lazy toolset). The agent reads the
image through the `{{media}}` variable — the inbound photo is already attached to the
turn — then calls the tool. The monthly `schedules` entry (`0 9 1 * *` — 9am on the
1st) reuses exactly the scheduling pattern from [example 4](daily-report.md) to
produce the report.

## Step 5 — Restart, then try it

Restart for the new command and tool, then exercise all three paths:

```text
/expense 9.20 coffee
```

An instant row and a confirmation, with no model call — check the report and you'll
see the turn short-circuited at the command stage.

```text
@expenses [photo of a receipt]
```

The agent should read the total and category from the image and call `log_expense`;
the report shows the `{{media}}` it saw and the tool call it made.

Then trigger the monthly run and confirm a category summary lands in `Finance/`.

## Going further

- Add a `{{budget}}` variable (like [example 3](language-coach.md)'s) that flags
  when a category is over its monthly limit.
- Handle multiple currencies with the built-in `math` tool.
- Move the shared row-writing logic into one helper both the command and the tool
  import, so the ledger format lives in a single place.

## You've finished the series

You've now built across the whole spectrum: pure vault
([1](movie-tracker.md), [2](knowledge-tree.md)), a first custom variable
([3](language-coach.md)), scheduled web research ([4](daily-report.md)), and a full
tool-plus-command capstone. The reference behind any single piece lives in
[primitives](../codebase/primitives.md) and the [vault docs](../vault/agents.md), and
the day-to-day rhythm of building is [iteration](../iteration.md).
