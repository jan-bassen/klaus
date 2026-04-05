# TODO

## Commit to vault as core
- [ ] Have a simple generalized way to handle vaults with different structures (multiple vaults and folders) - doesn't need to be obsidian, but is designed with it in mind.
- [ ] Implement generalized verification system accross it, for safe defaults (not fully clear how, but maybe via file paths or with a in-code-defined schema)
- [ ] Extend flags to be more then pure injects - add !accept for auto-accept general behaviour and !accept-all for unsafe behavior (make the whole flags system more flexible and powerful, without clutter)
- [ ] Give Klaus its own explicit knowledge vault/folder à la [Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 
- [ ] Move settings into vault (=iteration in obsidian, not repo - only tools and commands there)
- [ ] Validate dynamic vault part loading on load and warn per WhatsApp
- [ ] Remove note system
- [ ] Have trailing logs in vault, but careful: That shouldn’t be too heavy on sync!
- [ ] Add message template to vault for easy iteration on formatting ("transcript from voice message", flags, ...)

## Remove bloat
- [ ] Remove cost tracking and budgets then merge data and files into one Klaus volume (data + config -> klaus; vault stays separate). Subfolders: auth/ for headless-obsidian and baileys, logs/, files/
- [ ] Remove note system (replaced by knowledge vault/folder)

## New commands
- [ ] /undo with a quoted message
- [ ] /retry on failed message

## Voice/tone overhaul
- [ ] Make voice the default output for longer messages
- [ ] Make new snippet for communication with clearer instructions for WA formatting and voice handling
- [ ] Make @agent and !flags in voice messages possible

## Provider indipendence
- [ ] Make it explicitly easy to use common providers and switch fluently
- [ ] Maybe (?) enable OpenAI OAuth?

## Message history overhaul
- [ ] remove reasoning from message history
- [ ] add new flow for very compact tool use summaries in message history (prob as custom message type)
- [ ] Maybe mental notes field to replies (to keep train of thought)
- [ ] @agent in message history or each has their own history? If yes, be wary of quoted messages!

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)
- [ ] Ingest - As input handler from source to wiki/knowledge store

# Later

## Security
- [ ] Look at the tool verification pipeline again. Probably use 👍/👎 for feedback and ✅/⛔ or /yes + /no for acceptance. Will need a flow for good ux (short description + tool name + maybe even params)
- [ ] Think about a potential "undo" operation. Maybe thats good?

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions

## Maybe's
- [ ] Voice language field in settings.ts against awkward accents
