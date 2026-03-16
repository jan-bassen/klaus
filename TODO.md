# TODO

## Memory and Context System Restructure
Snippets moved to vault (`Klaus/snippets/`), memory consolidated to `Klaus/memory.md`, user profile to `Klaus/user.md`. `auto_memory` (graph-context) removed — vault content accessible via tool calls. `reflection` agent removed — `memorize` agent handles memory updates.
- [x] Move snippets from context to vault
- [x] Implement a solid pipeline for memory and user files
- [x] Revalidate if the memory agents (memorize and reflection + even the vault agent) even serve a big enough purpose that make them worth keeping

## Skills
- [ ] Add skills to the example vault

## Check cron implementation
We moved from postgres to just files and obsidian, now the agent prompts live in the vault and can be live-edited (which is great), so I am unsure if I change the schedule, that the changes will not be applied automatically.
- [x] Check implementation for solution to this
- [x] Implement automatic reloading of cron jobs if possible
- [x] Search for other issues related to the "hot-loading" of agent files (tools, modelTiers, etc)
- Implemented: `src/core/watcher.ts` — `fs.watch` on agents/ and skills/ dirs with debounce, reconciles agentRegistry, skillRegistry, and cron schedules on file changes

## Store Check
- [ ] Check reply/quote flow after store change
- [ ] Check tooling around store, so Klaus can retrieve what he needs

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

## Cleanup
- [ ] volume names cleaner
- [ ] remove env.config
- [ ] Check for unnecessary files and functions (eg. check src/core/defaults.ts or src/core/middleware.ts)
- [ ] Check for outdated comments, documentation, or memory files
- [ ] Rename context queries to just context/context variables

##  Thorough code review
- [ ] Check for bad typescript patterns (as casts, any's, etc.)
- [ ] Check for custom validation code (instead of using zod)
- [ ] Move any hardcoded strings or values into config files (not logs, internal stuff. Just user or agent-facing things)

## Hardening
- [ ] Check for unhandled edge cases and errors
- [ ] Surface the actual error messages to the user (not generic error message a la smth went wrong)

# Later

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## CI/CD
- [ ] GitHub Actions flow to build - then webhook on nas to redeploy
- [ ] Still hot-loading of md files

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions
