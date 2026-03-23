# TODO

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
