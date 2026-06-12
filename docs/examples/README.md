# Examples

Five follow-along builds, arranged as a difficulty ladder. Each one is a complete, working feature, and each owns exactly one new idea — later examples lean on the earlier ones instead of re-teaching them, so the gentlest path is to do them in order.

The code/no-code line falls between #2 and #3: the first two stay entirely in your vault (no TypeScript, no restart), and from the third onward you cross into `src/` for the first time. If you're new, start at the top.

1. **[Movie tracker](movie-tracker.md)** — *beginner · vault only.* The "hello world": an agent that appends to a note and reads it back. Your first feature, no code.
2. **[Knowledge tree](knowledge-tree.md)** — *beginner+ · vault only.* Curating a web of linked notes instead of one flat list — vault management (links, tags, backlinks) plus a skill.
3. **[Language coach](language-coach.md)** — *intermediate · first code.* Your first custom variable: surfacing persistent state into every turn so the agent *remembers*.
4. **[Daily report](daily-report.md)** — *intermediate+ · light code.* An agent that wakes itself on a schedule, researches the web with server tools, and writes you a digest — no inbound message needed.
5. **[Expenses tracker](expenses-tracker.md)** — *advanced · full code.* The capstone: a custom tool the model calls mid-reply, a `/command` that bypasses the model, plus an agent, a schedule, and media scanning.

These are referenced throughout the docs — see [iteration](../iteration.md#following-a-worked-build) for where they fit in the day-to-day loop, and [development](../development.md) for the code primitives they introduce.
