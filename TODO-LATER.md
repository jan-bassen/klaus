# TODO Later

## Security
- [ ] Look at the tool verification pipeline again. Probably use 👍/👎 for feedback and ✅/⛔ or /yes + /no for acceptance. Will need a flow for good ux (short description + tool name + maybe even params)
- [ ] Think about a potential "undo" operation. Maybe thats good?

## UX Improvements for Auth Flow
- [ ] Take QR out of the normal log flow
- [ ] Make getting chatID easier somehow?
- [ ] Add "me" mode (for people with no second number)

## New commands
- [ ] /undo with a quoted message
- [ ] /retry on failed message
- [ ] /accept <duration> to set the agent in auto-accept mode for a limited time
- [ ] /voice <duration> to set the agent in always tts mode for a limited time

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions

## Maybe's
- [ ] Voice language field in settings.ts against awkward accents
- [ ] Access to github

## Code Cleanup (Notes)
- [ ] else if -> switch (eg help command)
- [ ] commands/index.ts & register.ts merge and -> core or whatsapp 
- [ ] Maybe ./whatsapp -> ./chat
- [ ] Model command VALID_TIERS hardcoded (should be from settings)
- [ ] Tiers should be arbitrary model name map (opus, sonnet, …)
- [ ] Chars_per_token -> actual tokenizer if possible (sometimes it's also hardcoded... eg dispatch context). Also we're currently writing this in every query instead of handling it automatically for all
- [ ] Maybe file names in settings.ts (eg store/budgets.ts)?
- [ ] Budgets ts missing catch block(?)
- [ ] Remove unnecessary comments? (eg store/budgets.ts)
- [ ] Just clarify: Do I really need the conversation.ts indices (and why in both directions?)
- [ ] not all schemas seem to be actually used for validation (eg invocations?)
- [ ] We have a lot of transformations (are all done well + necessary?)
- [ ] store/jsonl.ts is for what? Maybe just bad naming? Can probably dissolve somewhere
- [ ] Are timers implemented well? Is setTimeout good for this? idk 
- [ ] Smart way to surface provider tool configs? (eg blocked or allowed domains etc)
- [ ] Check all tool descriptions for bad instructions ( e.g. 👍 to confirm, ✅ on task done, ❤️ for appreciation in react - this schould go into user prompts! also skills one is bad too!)
- [ ] files.upload for what?
- [ ] How to test right formatting etc for tools?
- [ ] vault.write as default overwrite seems scary, maybe separate with clearer names and correct confirmation
- [ ] I think we can remove the const casting  (const CONST_IN_FILE = settings.const)
- [ ] 60s confirmation timeout seems unnecessary. Why not keep it open until I decided? Surely that's possible
- [ ] We can probably clean up and reduce ./core and ./whatsapp
