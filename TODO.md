# TODO

## Memory and Context System Restructure
Snippets moved to vault (`Klaus/snippets/`), memory consolidated to `Klaus/memory.md`, user profile to `Klaus/user.md`. `auto_memory` (graph-context) removed — vault content accessible via tool calls. `reflection` agent removed — `memorize` agent handles memory updates.
- [x] Move snippets from context to vault
- [x] Implement a solid pipeline for memory and user files
- [x] Revalidate if the memory agents (memorize and reflection + even the vault agent) even serve a big enough purpose that make them worth keeping

## Skills
- [x] Add skills to the example vault


## Store Check
- [x] Check reply/quote flow after store change
- [x] Check tooling around store, so Klaus can retrieve what he needs

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

## Cleanup
- [x] volume names cleaner (obsidian-sync → sync)
- [x] remove env.config (values moved to docker-compose.yml; code has sensible defaults)
- [x] Check for unnecessary files and functions — defaults.ts + middleware.ts are actively used, no dead code found
- [x] Check for outdated comments, documentation, or memory files — none found
- [ ] Rename context queries to just context/context variables

## Thorough code review
- [x] Check for bad typescript patterns — replaced `as` casts in stores with zod validation
- [x] Check for custom validation code — replaced manual validators with zod schemas (stores, agent frontmatter, registry, assemble)
- [x] Move any hardcoded strings or values into config files — each string appears once, not worth centralizing

## Hardening
- [x] Check for unhandled edge cases and errors — zod schemas now validate all JSON-parsed data at store boundaries
- [x] Surface the actual error messages to the user — intentionally generic for WhatsApp (don't leak internals); already logged server-side

## Tests
- [ ] Add schema validation tests for store schemas (src/store/schemas.ts)
- [ ] Fix pre-existing snippetsQuery test failure in assemble.test.ts

# Later

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## CI/CD
- [ ] GitHub Actions flow to build - then webhook on nas to redeploy
- [ ] Still hot-loading of md files

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions
