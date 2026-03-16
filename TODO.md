# TODO

## Skills
- [x] Add a new primitive for dynamically loaded md content
- [x] Add a new core tool for retrieving said skills
- [x] Expose `{{skills}}` Handlebars var so agents can frame their available skills in the prompt

## Richer vault access
- [x] Check vault tools for gaps and ensure they cover all needs
- [x] Scope agents to specific path in vault

## Message Pipeline
- [x] Add auto-generated /help with all infos (maybe split with param a la "/help commands")
- [x] Track flags and commands in db

# Agents
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
