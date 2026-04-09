# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Improve Whatsapp UX 
- [ ] Add initial short message when setup is completed successfully (if we dont have that already)
- [ ] Add self-mode (for people with no second number)
  - [ ] Check in login flow if the checkbox is ticked and skip straight to greeting message
  - [ ] Add handling of internal messages only
  - [ ] Add message formatting to see if it's from an agent (and which) with "[klaus]: actual output message"
- [ ] Check if there are unused possiblities in baileys or smth I missed?

## Better error handling UX
- [ ] Check retry flow for potential improvements and consider a potential "undo" operation
- [ ] if feasible add /undo with a quoted message
- [ ] if feasible add /retry with a quoted failed message

## Core cleanup -> Leaner Code, less files, more unification
Goal: I've worked with a lot of agents and the code quality drifts after a while. This is a bigger cleanup before I go in manually - simplicity is key
- [ ] Create new directory: templates where we can collect all text snippets and handle them unified with handlebars
- [ ] Find other places where we can unify code, make it simpler
- [ ] Make sure the code is human readible if possible
- [ ] Make sure everything is collocated
  - [ ] types file: resolve (?) Have them collocated at the right files at the top. Schemas > Direct Types 
  - [ ] settings file: resolve with settings-loader as settings.ts in core.
- [ ] Taking a good look at the core folder for unused/redundant code, collapsing files with similar intentions/scopes 
- [ ] Simplify names (vault-access -> vault, provider-factory -> providers, ...) I want anyone to look at the files and understand where is what while using single words
- [ ] Move flags from whatsapp into flags in core
- [ ] Create new directory with default vault setup instead of generating them on the fly
  - [ ] Remove prev. autogen (still add flags/ and notes/ anyways)
  - [ ] Like this we can just copy the default setup over on start (and user can adapt it before start or just copy it over himself)
- [ ] Make schemas dynamic. Stuff like providers should allow for all kinds of providers, if I want them hardcoded I don't need a schema... This will be also the case with other schemas! Find them and update them. 
- [ ] Every llm agent adds like a couple tests and we have a ton by now - check and prune all the useless ones

## Logging overhaul
- [ ] make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message (just the msg is default)
- [ ] How to handle other keys in the json in text or should I simplify the whole thing?
- [ ] Also many keys get called multiple times (eg. skipFromMe)
- [ ] Make sure all steps are understandable. (What does skipFromMe even mean?)

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Making everything human readible if possible
