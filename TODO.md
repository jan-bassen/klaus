# Repo cleanup

We'll be opening this up as "the agent for tinkerers". Polish the codebase and the docs before that.

## Docs

- [x] Remove personal image/repo artifacts from user-facing docs
- [x] Update README to be perfect and poignant (short intro + quick setup + architecture pointers to /docs)
- [x] Add `docs/`:
  - [x] setup-guide — deeper common setups + issues
  - [x] codebase-walkthrough — patterns, structure, key files/flows ("how to work with klaus' codebase 101")
  - [x] iterate-in-obsidian — most useful patterns with examples
  - [x] iterate-in-code — adding a command / variable / tool

## Comments

- [ ] Remove redundant comments (good naming > explanations; comments are for the non-obvious)
- [ ] Shorten comments where possible
- [ ] Final pass — everything up-to-date and matching the implemented code

## Agent tooling

The codebase should be ready for agents, but unopinionated.

- [ ] Shorten AGENTS.md further and optimise it for forkers
- [ ] Remove `.claude/`
