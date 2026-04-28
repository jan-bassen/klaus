# Code Walkthrough (Verify everything is implemented as intended)

- [ ] Init Flow
  - [ ] 

# Repo cleanup

We'll be opening this up as "the agent for tinkerers". Polish the codebase and the docs before that.

## Config

- [ ] move to node for industry default (clean up deps - currently 3x types)
- [ ] pin dependency versions? (or simpler fix for protection against supply chain attacks)
- [ ] remove and cleanup after fallow
- [ ] remove and cleanup after claude tooling + 
- [ ] remove .agent skills with simple docs guide in agents.md

## Code 

- [ ] 

## Docs

- [ ] Remove any personal artifacts (janbassen1/klaus, ...)
- [ ] Update README to be perfect and poignant (short intro + quick setup + architecture pointers to /docs)
- [ ] Add `docs/`:
  - [ ] setup-guide — deeper common setups + issues
  - [ ] codebase-walkthrough — patterns, structure, key files/flows ("how to work with klaus' codebase 101")
  - [ ] vault-walkthrough — vault side incl. key settings and folders
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
