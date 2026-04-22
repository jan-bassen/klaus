## src
```
- index.ts                         - start
- errors.ts
- pipeline/
	- index.ts                     - run: auth + full turn
	- agent.ts                     - core agent loop
	- context.ts                   - gather vars, tools, history,...
	- message.ts                   - normalizing, parsing, stripping
	- prompts.ts                   - assemble text from templates
	- config.ts                    - config retrieval, overrides, ...
	- media.ts                     - audio, images, docs, ...
- primitives/
	- tools/
		- set/                     - toolsets as before
		- index.ts                 - loading, validating, ...
		- reply.ts                 - tools and other primitives as before
		- ...
	- variables/
	- commands/
- infra/
	- logger.ts
	- simulation.ts
	- whatsapp/
		- confirm.ts (?)
		- connections.ts
		- login.ts
		- presence.ts
		- receive.ts
		- send.ts
	- vault/
		- index.ts
		- watcher.ts
		- markdown.ts
	- store/
		- index.ts
		- report.ts
		- history.ts
		- files.ts
		- schedules.ts
		- timers.ts
```

## Vault
```
- agents/
- reports/
- skills/
- snippets/
- templates/
	- message-user.md
	- message-agent.md
	- message-tool.md
	- report-short.md
	- report-full.md
	- error-message.md
- overrides.yml
- settings.yml
```

## Store
```
- auth/
- media/
- history/
- logs/
- schedules.json
- timers.json

```

## Core Flow

1. Auth (ChatID)
2. Normalize (STT)
3. Parse and Strip Message (commands, agents, overrides)

> *Dispatches start here*

4. Load Agent Config and apply overrides

> *Schedules and timers start here*

5. Load context (variables, tools, skills, chat history)
6. Assemble Prompts
7. Core Loop: Call LLM and handle output
8. Capture logs and reports

## Add
+ Reports (full overview of the whole turn; "full" includes full turn, "agent" only the llm part)
+ Image Editing/Creating
+ Simulation Mode - Try an action with real data, but not real consequences via a simple transaction like interface for tools
+ Bundle obsidian sync into docker Container 

## Simulation Mode 
Try actions with real data, no real consequences. Replaces evals and approval flow in spirit (evals overkill, real testing pretty annoying rn). Allows user to try and test stuff in real environment while keeping data safe (doesn't need to cover 100%)
- Activated via `!simulate override; reports (always produces one) flagged as SIMULATION
- Tool declares `sideEffect: "external" | "stateful" | "pure"` (enforced at registration)
	- `external` (reply, send, react, TTS, dispatch): check `ctx.simulation`, fake a plausible result, log intended action
	- `stateful` (vault, files, schedules, timers): route through simple per-turn memory overlay so consecutive actions don't break the simulation flow
	- `pure` (reads, search): pass through

## Dispatch
- Simplified: default agent "dispatch" with generic "helper" system prompt (still allows for others, but dispatch is clear default). Dispatch tool allows for multiple agents to be dispatched simultaneously for actual parallel workflows. async is just a timer.
- Parallel inline replies: aggregate replyCollector by dispatch index (not completion order) so voice/TTS output stays deterministic.

## Remove
- Trimming Strategies (only trunc helper)
- Rate Limit (only one chat, if we have a guard it's against runaway agents not messages)
- Log trail in Vault (replaced w/ reports)
- Evals (overkill)
- Complex Permissions + Approval Flow

## Agent Schema
Auto-persistance via forced tool call (instead of structured output). Agent get a hint (goal of it's persistance) needs to define the next run incl. the prompt and optional overrides for it. 
```js

const AgentSettings: z.object({
	provider: z.string().optional(),
	modelTier: z.enum(modelTiers).optional(),
	voice: z.enum(["on", "auto", "off"]).default("auto"),
	accept: z.boolean().default(false),
	temp: z.enum(["cold", "default", "hot"]).default("default"),
	topP: z.enum(["creative", "default", "rigid"]).default("default"),
	reasoningEffort: z.enum(["low", "default", "high"]).default("default"),
	stepLimit: z.number().optional(),
	historyLimit: z.number().optional(),
	historyScope: z.enum(["full", "agent"]).optional(),
	historyTraces: z.enum(["full", "summary", "none"]).default("summary"),
	report: z.enum(["full", "agent", "none"]).default("agent"),
	vault: z.record(z.string(), z.enum(["none", "read", "full"])).optional()
})

export const AgentSchema = z.object({
	name: z.string().min(1),
	aliases: z.array(z.string()).optional(),
	tools: z.array(z.string()).optional(),
	toolsets: z.array(z.string()).optional(),
	providerTools: z.array(z.string()).optional(),
	skills: z.array(z.string()).optional(),
	settings: AgentSettings.optional(),	
	persistance: z.discriminatedUnion("mode", [
		z.object({
			mode: z.literal("static"),
			schedule: z.string(),
			prompt: z.string(),
			overrides: Overrides
		}),
		z.object({
			mode: z.literal("dynamic"),
			hint: z.string()
		}),
	])
});
```

## Settings Schema
```js
basics (locale, timezone, ...)
agentDefaults
	provider
	modelTier
	voice
	accept
	temp
	vault            # { "*": "read", "Training": "full", "Private": "none" }
	...
providers
media
	voice
		tts
			provider
			model
			voiceId
			timeout
		stt
			provider
			model
			agentTriggers
			timeout
	image
		vision
			maxSize
			timeout
		gen
			provider
			model
			timeout
	document
		ocr
		timeout
	web
		timeout
whatsapp
	retries
	sendDelay
	selfMode
	maxDownload
	mediaDownloadTimeout
    offlineWindow
    maxSeenSize
vault
	watcherDebounce
	maxList
persistance
	minNextRun
	maxNextRun
```
