# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Harden vault as flexible core
- [ ] Have a simple generalized way to handle vaults with different structures (multiple vaults and folders) - doesn't need to be obsidian, but is designed with it in mind (probably with just multi-vault support and folder-level permissions: read|append|write + always/request)
- [ ] Implement generalized verification system accross it, for safe defaults (not fully clear how, but maybe via file paths or with a in-code-defined schema) - higher level settings should be overwritten by nested settings
- [ ] Keep internal folder (with agents/, skills/, ...) separate (but able to be colocated) for efficient watcher and clear separatation of concern (maybe add layout check?)
- [ ] Recheck vault tools with new design

## Move Settings to vault
- [ ] Move settings.ts into vault as settings.yml (=iteration in obsidian, not repo - only tools and commands there) - settings that need to stay in code can go into a config.ts file instead.
- [ ] Add dynamic loading incl. validation via zod schema on load and warn per WhatsApp (keep last valid state)

## Context variable extension
- [ ] Add context variable support to live messages (not just system prompt) - syntax in message is $var bc hds are annoying to type out on mobile
- [ ] Add back simple params as core part of vars {{tasks?limit=3}} or $tasks?limit=3
- [ ] Keep snippets folder for now both system and user messages, but now with frontmatter to define scope and maybe params (?)

## Flags repurpose
- [ ] Turn flags from injections (those are now handled with $vars) to add inline programmatic control over the current message (more similar to commands)
- [ ] keep !voice, but as guaranteed switch to tts
- [ ] !accept for auto-accept mode (vault and tools) 
- [ ] !accept-unsafe for unsafe auto-accept (vault and tools) 
- [ ] Maybe !accept-vault and accept-tools (+ unsafe versions) for finer control?
- [ ] !small|medium|large for direct model control
- [ ] !chatgpt|claude|gemini (dynamic - see below) for direct model set control
- [ ] !cold|hot for temperature control
- [ ] !clean for a call without messages context
- [ ] !ghost for a call that doesn't get logged or added to history + auto-deleted (where possible)

## Provider option flags (not all providers are the same, see what's possible)
- [ ] !low|high for reasoning effort control
- [ ] !verbose|concise for verbosity control
- [ ] !no-tools|use-tools for enforced tool-use

## Remove bloat
- [ ] Remove cost tracking and budgets then merge data and files into one Klaus volume (data + config -> klaus; vault stays separate). Subfolders: auth/ for headless-obsidian and baileys, logs/, files/
- [ ] Remove note system (replaced by knowledge vault/folder)

## New commands
- [ ] /undo with a quoted message
- [ ] /retry on failed message
- [ ] /models and /model commands for changing model set and default in the set
- [ ] /accept <duration> to set the agent in auto-accept mode for a limited time
- [ ] /voice <duration> to set the agent in always tts mode for a limited time

## Help command overhaul
- [ ] Maybe switch to /? (?)
- [ ] Add $vars (incl. params) 
- [ ] Add vault overview incl. permissions

## Voice/tone overhaul
- [ ] Make voice the default output for longer messages
- [ ] Make new snippet for communication with clearer instructions for WA formatting and voice handling
- [ ] Make @agent and !flags in voice messages possible via fuzzy matching (agent routing at the start ("hey", "at", "an", "to", ... + {one of the agent names}) and flags at the end ("flags", "flagged with", "tags", "tagged with", ... + names of flags))

## Provider independence
- [ ] Make it explicitly easy to use common providers and switch fluently (maybe default to OpenRouter?)
- [ ] Switch to generalized model picker (free map, maybe with different sets of [small|medium|large] (schema changible) - default three sets: chatGPT, claude, gemini) 
- [ ] Maybe (?) enable OpenAI OAuth if possible?

## Conversations overhaul 
Goal: create a simple unified data store for a) execution and b) debugging
- [ ] Add message.md template with handlebars to vault for easy iteration on formatting ("transcript from voice message", flags, ...)
- [ ] Rework the message history to be optimized for what the agent sees (ack's as fields not own message type, tool usages only as short summaries, reasoning as mental notes as field) 
- [ ] Move to single jsonl file per day for message history. /new becomes /break as a new "no context from before here" marker
- [ ] Rework the invocations to have full overview of the pipeline (incl. raw message, params, full message, ...) and a clearer steps array (currently very nested and badly readible - see EXAMPLES folder)
- [ ] Add trailing logs (maybe last 3 days) to vault /Klaus/trail/ for easy debug, but careful: That shouldn’t be too heavy on sync!
- [ ] Add agent.md frontmatter option for control over tool use in context (default on)
!Problem: How to keep train-of-thought between messages? Maybe be a mental notes field in the structured output?


## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)
- [ ] Ingest - As input handler from source to wiki/knowledge store à la [Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Documentation
- [ ] Update readme and check code comments etc
