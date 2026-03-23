# TODO

## Iteration
- [x] tasks/ops → Replaced with unified `dispatch` toolset (dispatch.agent, dispatch.schedule, dispatch.timer, dispatch.list, dispatch.cancel). Uses `croner` for cron, `setTimeout` for one-time timers. Cost tracking extracted to standalone `cost_tracking` tool. File-based task queue removed in favor of in-memory job tracking.
- [ ] Alle Primitives runterbrechen und gut erklären in docs etc (agents, commands, context vars, tools, skills, notes, flags, snippets + dispatch primitives). Gut gruppieren/ordnen
- [ ] Alles zod prüfen lassen, statt custom checks or no check at all (check codebase for gaps/ cases)!
- [ ] Vault-Tooling und instructions sollten besser sein (besonders discovery und gezielte Änderungen)
- [ ] React/reply flow/anweisungen verbessern (ist wierd manchmal - zB. Ich stell ne Frage und es kommt nur 👍, oder es kommen beides ne Reaktion und Antwort, wenn eins gereicht hätte)
- [x] Wir brauchen nur eine flags.ts — `src/flags.ts` handles flag registry; `src/whatsapp/flags.ts` handles message parsing (separate concerns, both needed)
- [ ] use _ for toolset tools? Klaus tried to use them like that a few times already

## Prompts
- [ ] Es gibt kein <cite> support bei Whatsapp! 
- [ ] Nachrichten sind zu lang, Klaus fällt häufig in den default assistant zurück statt passend für Whatsapp...
- [ ] Improve voice prompt (ist gerade sehr langsam/ erzählerisch/ unnatürlich). Current: "Eine tiefe, raue Stimme mit leichtem Knarzen — wie ein alter Seemann aus Norddeutschland, der viel erlebt hat. Ruhig und warm im Kern, aber mit einer trockenen, knorrigen Kante. Spricht bedächtig, fast gemütlich, kann aber auch mal brummig werden. Norddeutsch nüchtern, nie überschwänglich — Herzlichkeit zeigt sich eher zwischen den Zeilen als in der Lautstärke. Ein Hauch von Salz und Wind in der Stimme."

## New commands
- [ ] /stop - stop the current task gracefully, but promptly (in case Klaus decides to do something i don't want)
  - [ ] Add good instructions for it too (eg. Note structure/ headings overview)
- [ ] /model - change the model of current default agent

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

# Later

## GitHub Actions CI/CD for automated image publishing

## UX/DX improvements
- [ ] Add commands for direct control over model tier etc
- [ ] Add config entry for switching between default logs or full logs


## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions
