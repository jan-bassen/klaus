# TODO

## Iteration
- [x] Make persistence (recurring calls) explicit — `persistent: true` frontmatter + structured output `{ nextRun, objective }`
- [ ] Add traces conversion limit param to agents for finer control
- [ ] Check for unused baileys potential and fix persistence 
- [ ] Validate dynamic vault part loading on load and warn per WhatsApp

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)

# Later

## Security
- [ ] Look at the tool verification pipeline again. Probably use 👍/👎 for feedback and ✅/⛔ or /yes + /no for acceptance. Will need a flow for good ux (short description + tool name + maybe even params)

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions

## Maybe's
- [ ] Voice language field in settings.ts against awkward accents
