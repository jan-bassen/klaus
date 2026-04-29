# Fixes from testing

- [x] startup flow bad!
- [x] /help
  - [x] shorten descriptions more where possible
  - [x] remove variables
  - [x] reduce to providers instead of models
  - [x] remove vault part
  - [x] show command params
  - [x] better formatting:
    - [x] not a list, but `*main [aliases]* <params>` then in new line description
- [ ] Lange reports einzeln?
- [ ] Error handling
  - [ ] Failed = emoji reaction
  - [ ] easy retry option
  - [ ] easy check error option
- [x] image_edit tool
- [ ] Reduce to single report template (full)

# Repo cleanup

We'll be opening this up as "the agent for tinkerers". Polish the codebase and the docs before that.

## Config

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
