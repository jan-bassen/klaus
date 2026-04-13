# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Testing suite check
Goal: We've reached hundreds of tests for a pretty small codebase. Also some tests take a ton of time, making the agentic workflow much slower. Let's make the suite leaner and better. Remove useless tests and merge overlaps, be pretty ruthless here. I doubt we actually need 150+ tests. Reduce time of timeout tests when we really really need them - otherwise cut them the most aggressively

## Skill tools
- [ ] Allow for extra tools to be added to context when skill called

## Unified setup through vault defaults (?)
Goal: Move all interaction/customization surface into vault or extra "extensions" volume
- [ ] Add folder to repo "default" containing my default vault setup - on init just copy, not generate
- [ ] Create new directory: templates where we can collect all text snippets and handle them unified with handlebars - templates/dictionaries for all the internal text parts (+ add to reference) - include currently top-level "message.md". Exclusions: Error messages, tools
- [ ] Add new volume folder "extensions/plugins" for user created commands, context vars, tools, and overrides that get loaded (auto or maybe on /refresh or so)
- [ ] Remove prev. vault autogen (currently still adds overrides/ and notes/ for example)

## Logging overhaul
- [ ] Make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message (just the msg is default)
- [ ] How to handle other keys in the json in text or should I simplify the whole thing?
- [ ] Also many keys get called multiple times (eg. skipFromMe)
- [ ] Make sure all steps are understandable. (What does skipFromMe even mean?)

## Code quality
- [ ] Make schemas dynamic (or extendible depending on context). Stuff like providers should allow for all kinds of providers, if I want them hardcoded I don't need a schema... This will be also the case with other schemas! (providers, overrides, ...)
- [ ] Every llm agent adds like a couple tests and we have a ton by now - check and prune all the useless ones
- [ ] Simplify any complex or deeply nested stuff: objects, joints, definitions, ...
- [ ] Make names clear and understandable and confirm uniformity of naming across codebase

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Add guides etc
