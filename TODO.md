# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Logging overhaul
- [x] Make "pretty" logging (and its setting) clearer. It should just be an optional switch to output full json logs or just the message string (just the msg str is default)
- [x] Check the loggings' other key-value pairs (from the json) if they should be added to the message text or should I just simplify the whole thing (always only log text)?
- [x] Also many keys get called multiple times (eg. skipFromMe)
- [x] Make sure all steps are understandable/ clear what they mean for anyone. (eg. what does skipFromMe even mean?)

## Code quality
- [x] Make schemas dynamic (or extendible depending on context). Providers resolved dynamically, overrides schema uses `.passthrough()`
- [ ] Simplify any complex or deeply nested stuff: objects, joints, definitions, ...
- [ ] Make names clear and understandable and confirm uniformity of naming across codebase
- [ ] Contain baileys imports to just whatsapp/ + check the codebase for other similar leaks

## Documentation
- [ ] Update readme and check code comments, everything should be up-to-date and fitting with the implemented code
- [ ] Add guides etc
