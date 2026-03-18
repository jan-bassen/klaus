# TODO

## Fixes
- [x] Logs: Remove the complexity of "pretty" logs, and just make them as good as can be for the current setup. This part: " [agent] calling model " is rendered white on white for me currently
- [x] Schedules Base: Fixed timezone-aware cron matching (was using UTC instead of Europe/Berlin)
- [x] Schedules Agent Interface: Added oneTime support so agents can schedule one-shot runs
- [x] Schedules Conversation History: Verified already correct — scheduled runs don't get conversation history (buildConversationMessages returns empty when turn.message is undefined)
- [x] Tool Results in Conversation history: That the tool-calls and results get injected into the conversation history is intended in a minimal way. But in testing this lead to many errors a la "Something went wrong: Tool result is missing for tool call toolu_01JwqrzJ5RfKFEZucCH6jypG.". This is bad on multiple levels: First why are they failing so often. Second that should never happen, either it is still in progress (then mark it as such) or it failed (then mark it also + give a reason + give a hint to fix if possible)

## Move Flags to Vault
- [ ] Move all flags also into the vault (eg. /Klaus/flags/voice.md with short description for help in frontmatter)
- [ ] Make sure they are also live-handled as the rest

## Simplify Context Queries
- [ ] the context/flags should be unnecessary after they moved to vault (and are not in the system prompt anymore anyways)
- [ ] Rename Context Query to Context Variables (they used to work with pg) and have a look of there is code in there that's not needed anymore
- [ ] Remove the memory file and rely on notes (aside from vault, prompts, and conversation ofc) for all (extra) memory stuff - it didn't really add anything

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

# Later

## GitHub action ci/cd for image building (?)

## UX/DX improvements
- [ ] Add commands for direct control over model tier etc
- [ ] Add config entry for switching between default logs or full logs


## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions
