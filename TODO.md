# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Skill tools
- [ ] Allow for extra tools to be added to context when skill called

## Unified setup through vault defaults
Goal: Move all interaction/customization surface into vault or extra "extensions" volume
- [x] Add folder to repo "default" containing my default vault setup - on init just copy, not generate
- [x] Remove settings.yml auto-generation (replaced by defaults copy)
- [x] Remove prev. vault autogen (currently still adds overrides/ and notes/ for example)

## Logging overhaul
- [ ] Make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message string (just the msg str is default)
- [ ] Check the loggings' other key-value pairs (from the json) if they should be added to the message text or should I just simplify the whole thing (always only log text)?
- [ ] Also many keys get called multiple times (eg. skipFromMe)
- [ ] Make sure all steps are understandable/ clear what they mean for anyone. (eg. what does skipFromMe even mean?)

## Code quality
- [x] Make schemas dynamic (or extendible depending on context). Providers resolved dynamically, overrides schema uses `.passthrough()`
- [ ] Simplify any complex or deeply nested stuff: objects, joints, definitions, ...
- [ ] Make names clear and understandable and confirm uniformity of naming across codebase

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Add guides etc
