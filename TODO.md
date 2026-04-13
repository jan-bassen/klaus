# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Improve Whatsapp UX 
- [x] Add short greeting message when initial setup is completed successfully (already existed)
- [x] Add self-mode (for people with no second number)
  - [x] Check in login flow if selfMode is set and skip straight to greeting message
  - [x] Add handling of internal messages only (fromMe with loop prevention via sent-ID tracking)
  - [x] Add message formatting to see if it's from an agent (and which) with "[AgentName]: message" / "[System]: message"
- [x] Check if there are unused possiblities/ open improvement opportunities through baileys or smth I might've missed? → Added read receipts (blue ticks after processing)

## Better error handling UX
- [ ] Check retry flow for potential improvements and consider a potential "undo" operation
- [ ] if feasible add /undo with a quoted message
- [ ] if feasible add /retry with a quoted failed message

## Pipeline Cleanup
- [ ] runAgent() is doing too much (~365 lines): This is the biggest concentration of complexity. Each of these is a distinct concern. The provider options block (lines 622-693) especially reads like a configuration builder that could be extracted. And buildConversationMessages is already a standalone function — it could live in its own file given its size and the trace-replay complexity.
- [ ] Setup mode is inline in the pipeline. The setup code matching (lines 80-106) is a self contained mini-flow embedded in the auth check. It could be a function call like handleSetupMode(msg).
- [ ] Quoted message media resolution (lines 221-246): This is a mini-concern (lookup by messageId, fallback by externalId) wedged between routing and persistence. Not wrong, but it's the kind of thing that breaks the otherwise clean linear flow.
- [ ] Flag/override/mode resolution is spread across multiple steps parseFlags → resolveOverrides → applyModeDefaults → then individual override fields are read scattered throughout runAgent(). The resolution chain is correct but the final consumption is scattered

## Flags cleanup
- [ ] Update flags structure to be like the others: top-level folder with grouped single files and a unified interface/ schema
- [ ] Make flags dynamic (read from flags folder)
- [ ] Move flags.ts from whatsapp into flags.ts in core (merge)

## Unified setup through vault defaults
Goal: Move all interation/customization surface into vault or extra "extensions" volume
- [ ] Add folder to repo "default" containing my default vault setup - on init just copy, not generate
- [ ] Create new directory: templates where we can collect all text snippets and handle them unified with handlebars - templates/dictionaries for all the internal text parts (+ add to reference)
- [ ] add new volume folder "extensions/plugins" for user created commands, context vars, tools, and flags that get loaded (auto or maybe on /refresh or so)
- [ ] Remove prev. vault autogen (currently still adds flags/ and notes/ for example)

## Core cleanup -> Leaner Code, less files, more unification
Goal: I've worked with a lot of agents and the code quality drifts after a while. This is a bigger cleanup before I go in manually - simplicity is key. Find other places where we can unify code, make it simpler + Make sure the code is human readible if possible
- [ ] Make sure everything is collocated
  - [ ] types file: resolve (?) Have them collocated at the right files at the top. Schemas > Direct Types 
  - [ ] settings file: resolve with settings-loader as settings.ts in core.
- [ ] Taking a good look at the core folder for unused/redundant code, collapsing files with similar intentions/scopes 
- [ ] Simplify names (vault-access -> vault, provider-factory -> providers, ...) I want anyone to look at the files and understand where is what while using single words
- [ ] Make schemas dynamic. Stuff like providers should allow for all kinds of providers, if I want them hardcoded I don't need a schema... This will be also the case with other schemas! Find them and update them. 
- [ ] Every llm agent adds like a couple tests and we have a ton by now - check and prune all the useless ones

## Logging overhaul
- [ ] make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message (just the msg is default)
- [ ] How to handle other keys in the json in text or should I simplify the whole thing?
- [ ] Also many keys get called multiple times (eg. skipFromMe)
- [ ] Make sure all steps are understandable. (What does skipFromMe even mean?)

## Skill tools
- [ ] Allow for extra tools to be added to context when skill called

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Making everything human readible if possible
