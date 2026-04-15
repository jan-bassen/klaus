# Features v0.2.0 (ignore migration paths, we're able to fully reset still)

## Clear up and improve attachment/variable flows: 
  - [ ] rename src/context/ -> variables
  - [ ] remove UserMessageFallback and throw when now message template found
  - [ ] unify variable flow accross all templates (every template gets every variable + all are defined in a centralized place - src/variables/)
  - [ ] nest variables better (group related ones, so it's easier to reason about them - optimal case: 1 group = 1 file and not deeper than that)
  - [ ] Rethink and rename variables to be very usable and easy to understand. Examples of what I dont want from what we currently have: `extractedText` as top-level var for parsed document content. It should be att.doc.text or smth
  - [ ] Remove the currently messy setup for truncate options for vars into a unified system of limiting a var to a certain char length in handlebars directly

## Improve media/research flows
Plan: Have a good look at the current document/web flow to give the agent efficient tools for common use-cases
Options:
- [x] liteparse for better document flow — inline parse on current message, `files.read` tool for older/quoted attachments, `.parsed.txt` sidecar cache
- [ ] rename parse-document in pipeline to attachments (it will also include the web-links in the next step)
- [ ] Handle a message contains one or more weblinks similarly: custom auto-webfetch + parsing with defuddle
- [ ] add custom web-fetch tool with defuddle

## Very simple evals
Goal: Add a simple system for a few key evals + live testing system to catch 80% of issues while iterating

## Code quality
- [x] Make schemas dynamic (or extendible depending on context). Providers resolved dynamically, overrides schema uses `.passthrough()`
- [ ] Make sure we are consistent in file extensions (eg overrides.yaml and settings.yml, but maybe more cases across codebase): always use shortest name
- [ ] Contain baileys imports to just whatsapp/ + check the codebase for other similar leaks

## Remove remainder of token tracking
we still have stuff like "charsPerToken" in settings, although that doesn't even make sense. Let's clean that up. Track chars if we need to track something, but why would we?

## Maybe's
- [ ] Voice language field in settings.ts against awkward accents

--- 

# Repo understandability v0.2.0
I decided I want to open source this as "the agent for tinkerers". Let's make this codebase perfect.

## Remaining cleanup 
- [ ] remove any unnecessary config/top-level files used for my dev environment
- [ ] move setting defaults out of the schema, everything else already lives in the Klaus folder

## Add docs
- [ ] Update readme to be perfect and poignant (short intro (incl what it is and isn't) + quick setup guide + architecture overview inlc how to tinker infos and pointers to /docs)
- [ ] Add docs/ with:
  - [ ] setup-guide (more in-depth guide for common setups and issues)
  - [ ] codebase-walkthrough (not 1:1 explainer of code, but more so the used patterns, chosen structure, key files, etc - like getting a 10min "how to works with klaus' codebase 101" class)
  - [ ] vault-walkthrough (same but with the vault side incl key settings and folders)
  - [ ] iterate-in-obsidian (quick explainer of the most useful patterns with examples)
  - [ ] iterate-in-code (same with code for adding a command, variable, tool, ...)

## Comments cleanup
- [ ] Remove any redundant comments (use good naming and clear code over explanations - comments are for anything that the code doesn't show or where misunderstandings are possible)
- [ ] Shorten comments where possible
- [ ] Make sure comments cover the ide inline 
- [ ] Check everything as final check - it should be up-to-date and fitting with the implemented code

## Cleanup agent tooling 
The codebase should be ready for agents, but fully unopinionated. 
- [ ] CLAUDE.md -> AGENT.md + shorten drastically while optimizing for future forkers
- [ ] remove REFERENCE & TODO
- [ ] remove .claude
