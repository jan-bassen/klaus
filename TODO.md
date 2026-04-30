# Fixes from testing

- [x] /help cleanup #2
  - [x] Add settings section with agent, model tier, voice, report, and history
  - [x] Move Agents after settings section (before commands) and add provider/model + history info as one more new here if set
  - [x] Remove Provider section
- [ ] Error handling
  - [x] Failed = emoji reaction (already wired; verify visibility — see `[send] reaction failed` warns)
  - [x] easy retry option (`/retry` — quote a message or retry last failed)
  - [ ] easy check error option
  - [ ] maybe backup models?
- [x] image_edit tool
- [ ] make toolsets less confusing for agents (they work got after injection, agent doesn't understand first call. maybe name from use_ to loadToolset or smth?)


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
