# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Improve Whatsapp UX 
- [x] Add short greeting message when initial setup is completed successfully (already existed)
- [x] Add self-mode (for people with no second number)
  - [x] Check in login flow if selfMode is set and skip straight to greeting message
  - [x] Add handling of internal messages only (fromMe with loop prevention via sent-ID tracking)
  - [x] Add message formatting to see if it's from an agent (and which) with "[AgentName]: message" / "[System]: message"
- [x] Check if there are unused possiblities/ open improvement opportunities through baileys or smth I might've missed? → Added read receipts (blue ticks after processing)

## Flags cleanup
- [x] Update flags structure to be like the others: top-level folder with grouped single files and a unified interface/ schema
- [x] Make flags dynamic (read from flags folder)
- [x] Move flags.ts from whatsapp into flags.ts in core (merge)

## Logging overhaul
- [ ] make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message (just the msg is default)
- [ ] How to handle other keys in the json in text or should I simplify the whole thing?
- [ ] Also many keys get called multiple times (eg. skipFromMe)
- [ ] Make sure all steps are understandable. (What does skipFromMe even mean?)

## Skill tools
- [ ] Allow for extra tools to be added to context when skill called

## Unified setup through vault defaults (?)
Goal: Move all interation/customization surface into vault or extra "extensions" volume
- [ ] Add folder to repo "default" containing my default vault setup - on init just copy, not generate
- [ ] Create new directory: templates where we can collect all text snippets and handle them unified with handlebars - templates/dictionaries for all the internal text parts (+ add to reference)
- [ ] add new volume folder "extensions/plugins" for user created commands, context vars, tools, and flags that get loaded (auto or maybe on /refresh or so)
- [ ] Remove prev. vault autogen (currently still adds flags/ and notes/ for example)

## Pipeline Cleanup
- [ ] runAgent() is doing too much (~365 lines): This is the biggest concentration of complexity. Each of these is a distinct concern. The provider options block (lines 622-693) especially reads like a configuration builder that could be extracted. And buildConversationMessages is already a standalone function — it could live in its own file given its size and the trace-replay complexity.
- [ ] Setup mode is inline in the pipeline. The setup code matching (lines 80-106) is a self contained mini-flow embedded in the auth check. It could be a function call like handleSetupMode(msg).
- [ ] Quoted message media resolution (lines 221-246): This is a mini-concern (lookup by messageId, fallback by externalId) wedged between routing and persistence. Not wrong, but it's the kind of thing that breaks the otherwise clean linear flow.
- [ ] Flag/override/mode resolution is spread across multiple steps parseFlags → resolveOverrides → applyModeDefaults → then individual override fields are read scattered throughout runAgent(). The resolution chain is correct but the final consumption is scattered

## Core cleanup
- [ ] Collapse outdated files (defaults, )
- [ ] Check middleware, what does middleware mean here? It only checks chatID, but we can do that in core pipeline right?
- [ ] 
- [ ] Simplify names if not already done in prev step (vault-access -> vault, provider-factory -> providers, ...) I want anyone to look at the files and understand where is what while using single words


## Code cleanup -> Leaner Code, less files, more unification
Goal: I've worked with a lot of agents and the code quality drifts after a while. This is a bigger cleanup before I go in manually - simplicity is key. Find other places where we can unify code, make it simpler + Make sure the code is human readible if possible
- [ ] /whatsapp/confirm -> core (make whatsapp folder 'pure')
- [ ] /context rename to /variables for clarity (use ide, but check code for missing renames after)
- [ ] check types handling, are there different patterns across codebase? If yes, find good pattern (preferably colocation) and unify
  - [ ] types file: resolve (?) Have them collocated at the right files at the top. Schemas > Direct Types 
- [ ] same with file patterns (eg: using index.ts files and not types.ts)
  - [ ] settings file: resolve with settings-loader as settings.ts in core.
Extra:
- [ ] Make sure everything else is also collocated
- [ ] Make schemas dynamic. Stuff like providers should allow for all kinds of providers, if I want them hardcoded I don't need a schema... This will be also the case with other schemas! Find them and update them. 
- [ ] Every llm agent adds like a couple tests and we have a ton by now - check and prune all the useless ones

## Code Readibility
Goal: Make everything human readible if possible
- [ ] Simplify any complex or deeply nested stuff: objects, joints, definitions, ...
- [ ] Make names clear and understandible and confirm uniformity of naming across codebase
- [ ] 

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Add guides etc
