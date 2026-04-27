- [ ] [agent] in non-default agent wa message (maybe template message-agent.md?)


# Repo understandability v0.2.0

Opening this up as "the agent for tinkerers". Polish the codebase and the docs before that.

## Check
- [ ] what happens when a message comes in while running?

### Docs

- [ ] Update README to be perfect and poignant (short intro + quick setup + architecture pointers to /docs)
- [ ] Add `docs/`:
  - [ ] setup-guide — deeper common setups + issues
  - [ ] codebase-walkthrough — patterns, structure, key files/flows ("how to work with klaus' codebase 101")
  - [ ] vault-walkthrough — vault side incl. key settings and folders
  - [ ] iterate-in-obsidian — most useful patterns with examples
  - [ ] iterate-in-code — adding a command / variable / tool

### Comments cleanup

- [ ] Remove redundant comments (good naming > explanations; comments are for the non-obvious)
- [ ] Shorten comments where possible
- [ ] Final pass — everything up-to-date and matching the implemented code

### Agent tooling

The codebase should be ready for agents, but unopinionated.

- [ ] CLAUDE.md → AGENT.md (shorten further, optimise for forkers)
- [ ] Remove `.claude/`
