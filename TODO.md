# Repo cleanup

We'll be opening this up as "the agent for tinkerers". Polish the codebase and the docs before that.

## Code

- [ ] Add `schedules` variant to `TaskEntry` in `src/primitives/variables/tasks.ts` (currently anticipating it via the `kind: "timer"` discriminator but only timers exist)
- [ ] Presence: refresh `composing`/`recording` periodically — Baileys presence updates expire after ~10s, so long agent turns drop the typing indicator mid-reply. Hook a repeating ping into `pipeline/index.ts` (or `presence.ts`) for the duration of the turn. Likely also wants `recording` for voice replies.
- [ ] Fix 5 pre-existing test failures (unrelated to repo cleanup pass):
  - `test/primitives/commands/default.test.ts` × 2 — `getDefaultAgent` cache-miss disk-load path no longer matches test expectations
  - `test/templates/golden.test.ts` × 3 — template snapshot drift

## Config

- [ ] pin dependency versions? (or simpler fix for protection against supply chain attacks)
- [ ] remove and cleanup after fallow
- [ ] remove and cleanup after claude tooling + 
- [ ] remove .agent skills with simple docs guide in agents.md


## Docs

- [ ] Remove any personal artifacts (janbassen1/klaus, ...)
- [ ] Update README to be perfect and poignant (short intro + quick setup + architecture pointers to /docs)
- [ ] Add `docs/`:
  - [ ] setup-guide — deeper common setups + issues
  - [ ] codebase-walkthrough — patterns, structure, key files/flows ("how to work with klaus' codebase 101")
  - [ ] iterate-in-obsidian — most useful patterns with examples
  - [ ] iterate-in-code — adding a command / variable / tool

## Comments

- [ ] Remove redundant comments (good naming > explanations; comments are for the non-obvious)
- [ ] Shorten comments where possible
- [ ] Final pass — everything up-to-date and matching the implemented code

## Agent tooling

The codebase should be ready for agents, but unopinionated.

- [ ] CLAUDE.md → AGENT.md (shorten further, optimise for forkers)
- [ ] Remove `.claude/`
