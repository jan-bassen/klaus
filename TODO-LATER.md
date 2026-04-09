# TODO Later

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)
- [ ] Ingest - As input handler from source to wiki/knowledge store à la [Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Maybe's
- [ ] Voice language field in settings.ts against awkward accents
- [ ] Access to github
- [ ] !accept-vault and accept-tools (+ unsafe versions) for finer control? (deferred — extend autoAccept type if needed)

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
