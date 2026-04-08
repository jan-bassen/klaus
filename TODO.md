# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Remove bloat
- [x] Remove cost tracking and budgets then merge data and files into one Klaus volume (data + config -> klaus; vault stays separate). Subfolders: auth/ for headless-obsidian and baileys, logs/, files/
- [x] Remove note system (replaced by knowledge vault/folder)

## Harden vault as flexible core
- [x] Make sure the setup works in a generalized way to handle vaults with different structures (multiple vaults and folders) - doesn't need to be obsidian, but is designed with it in mind
- [x] add folder-level permissions limits: read|append|full (default(always) is required, on-request limit optional - eg when you want: read only, append on request (verification flow), never write)
- [x] Keep internal folder (with agents/, skills/, ...) separate (but able to be colocated) for efficient watcher and clear separatation of concern. (default: read, request: full)

## Move Settings to vault
- [x] Move settings.ts into vault as settings.yml (=iteration in obsidian, not repo - only tools and commands there) - settings that need to stay in code can go into a config.ts file instead.
- [x] Add dynamic loading incl. validation via zod schema on load and warn per WhatsApp (keep last valid state)

## Context variable extension
- [x] Add context variable support to live messages (not just system prompt) - syntax in message is $var bc hds are annoying to type out on mobile, system prompt keeps full hbs support
- [x] Add back simple params as core part of vars {{tasks?limit=3}} or $tasks?limit=3
- [x] Keep snippets folder for now both system and user messages, but now with frontmatter to define scope and maybe params (?)

## Flags repurpose
- [x] Turn flags from injections (those are now handled with $vars) to add inline programmatic overwrites/control over the current message (closer to commands, but only for the current message)
- [x] keep !voice, but as guaranteed switch to tts
- [x] !accept for auto-accept mode (vault and tools) — also enforces requiresConfirmation on tools
- [x] !small|medium|large for direct model control
- [x] !cold|hot for temperature control (values from settings.llm.coldTemperature/hotTemperature)
- [x] !no-tools|use-tools for enforced tool-use control
- [x] !clean for a call without messages context
- [x] !ghost for ephemeral call — no persistence, skipHistory implied (WA message deletion deferred)

## Voice "mode" overhaul
- [x] Make voice the default output for longer messages
- [x] Make new snippet for communication with clearer instructions for WA formatting and voice handling
- [x] Make @agent and !flags in voice messages possible via fuzzy matching (agent routing at the start ("hey", "at", "an", "to", ... + {one of the agent names}) and flags at the end ("flags", "flagged with", "tags", "tagged with", ... + names of flags))

## Provider independence
- [x] Make it explicitly easy to use common providers and switch fluently (providers config in settings.yml with named entries: claude, chatgpt, gemini)
- [x] Create well designed model config (providers with sdk + small/medium/large/vision tiers)
- [x] Add a generalized model picker (three default providers: claude, chatgpt, gemini — extensible via catchall schema)
- [x] Include unified map of provider tools and options (canonical names: web_search, code_execution — resolved per provider SDK)
- [x] add /models and update /model commands for changing provider and tier (/model claude, /model large, /models to list all)
- [x] Add !chatgpt|claude|gemini flags for dynamic provider control

## Fix randomness control
- [x] Move the randomness settings temperature (!hot/cold, coldTemperature: 0 / hotTemperature: 1 in settings) into provider/model config
- [x] Add well-researched defaults for the three default provider model sets
- [x] Add topP control with !creative/!rigid flags (per-provider creativeTopP/rigidTopP)

## Provider option flags (not all providers are the same, see what's possible. When not supported ignore and inform)
- [x] !low|high for reasoning effort control (should be available for all three main providers)
- [x] !fast for fast mode (available on some)

## Conversations overhaul 
Goal: create a simple unified data store for a) execution and b) debugging
- [ ] Add message.md template with handlebars to vault for easy iteration on formatting ("transcript from voice message", flags, ...)
- [ ] Rework the message history to be optimized for what the agent sees (runtime usage: ack's as fields not own message type, tool usages only as short summaries) 
- [ ] Move to single jsonl file per day for message history. /new becomes /break as a new "no context from before here" marker
- [ ] Rework the invocations as logs to have full overview of the pipeline (incl. raw message, params, full message, ...) and a clearer steps array (currently very nested and badly readible - see EXAMPLES folder)
- [ ] Add trailing logs (maybe last 3 days) to vault /Klaus/trail/ for easy debug (minimize load on sync)
- [ ] Add agent.md frontmatter option for control over tool use in context (default on)

## Help command overhaul
- [ ] Maybe switch to /? (?)
- [ ] Add $vars (incl. params) 
- [ ] Add vault overview incl. permissions

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)
- [ ] Ingest - As input handler from source to wiki/knowledge store à la [Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Onboarding
- [ ] Auto-generate default settings.yml (and full internal folder structure) in vault on first startup

## Documentation
- [ ] Update readme and check code comments etc
