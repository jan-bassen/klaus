# Last Features

- [ ] Add read markers to messages to persistance
- [ ] Check Snippet vars in snippets - are they working (and how do we handle loops?)

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
  - [ ] codebase-walkthrough (not 1:1 explainer of code, but more so the used patterns, chosen structure, key files/flows, etc - like getting a 10min "how to work with klaus' codebase 101" class)
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
