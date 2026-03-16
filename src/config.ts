import path from "node:path";

export const config = {
	// Model tier map — change model IDs here to swap providers/versions globally.
	// Each tier is referenced by name throughout the codebase; no other file hardcodes model IDs.
	models: {
		default: "claude-sonnet-4-20250514", // main conversational agent
		low: "claude-haiku-3-20250307", // lightweight tasks, cheap calls
		high: "claude-opus-4-20250514", // @think — deep reasoning
		tts: "eleven_multilingual_v2", // ElevenLabs TTS
		stt: "scribe_v1", // ElevenLabs Scribe STT
		vision: "claude-sonnet-4-20250514", // image analysis (Claude)
	},

	// Per-model pricing in USD per million tokens. Used by model-router to compute costUsd.
	// Source: https://platform.claude.com/docs/en/about-claude/pricing (March 2026)
	pricing: {
		"claude-sonnet-4-20250514": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
		"claude-haiku-3-20250307": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
		"claude-opus-4-20250514": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
	} as Record<string, { inputPerMTok: number; outputPerMTok: number }>,

	// Per-service pricing for non-LLM API calls. Used to compute costUsd.
	apiPricing: {
		tts: { perMChars: 120.0 }, // ElevenLabs $0.12/1K chars
		stt: { perHour: 0.39 }, // ElevenLabs Scribe $0.39/hr
	},

	// Token budgets for context assembly. The assembler fills up to totalTokens,
	// then trims lower-priority sections first if everything doesn't fit.
	context: {
		totalTokens: 100_000, // hard cap passed to the model
		conversationTokens: 20_000, // recent message history (trimmed oldest-first)
		graphContextTokens: 40_000, // pinned vault notes + search results
		activeTasksTokens: 5_000, // in-flight async tasks
	},

	// Sliding-window rate limits. Two independent gates:
	// 1. messages   — checked by pipeline before any LLM work (blocks floods)
	// 2. modelCalls — checked by model-router per LLM invocation (blocks runaway loops)
	rateLimits: {
		messages: { max: 30, windowMs: 60_000 }, // 30 inbound messages per minute
		modelCalls: { max: 60, windowMs: 60_000 }, // 60 LLM calls per minute
	},

	// ElevenLabs TTS voice to use for outbound voice messages.
	tts: {
		voiceId: "z1EhmmPwF0ENGYE8dBE6",
	},

	// Retry policy for transient failures in async task jobs.
	retries: {
		max: 3, // attempts before marking a task failed
		backoffMs: 1_000, // base delay; actual delay = backoffMs * attempt (linear)
	},

	// Minimum pause after each outbound message before the next one is sent.
	send: {
		interMessageDelayMs: 1_500,
	},

	// Timeout for a single LLM generateText() call.
	llm: {
		timeoutMs: 120_000, // 2 minutes
	},

	// Timeouts for the startup sequence.
	startup: {
		connectionTimeoutMs: 60_000, // 1 minute to establish WhatsApp connection
	},

	// The agent that handles all messages not prefixed with an @route.
	defaultAgent: "klaus",

	// Locale and timezone used for date/time context injected into agent prompts.
	locale: "de-DE",
	timezone: "Europe/Berlin",

	// Dispatch chain limits.
	dispatch: {
		maxChainDepth: 10,
	},

	// Directory where uploaded and downloaded media files are stored.
	files: {
		get dir() {
			return process.env.FILES_DIR ?? path.join(process.cwd(), ".files");
		},
	},

	// Obsidian vault directory — agents, skills, and memory all live here.
	vault: {
		get dir() {
			return process.env.VAULT_DIR ?? path.join(process.cwd(), "vault");
		},
	},

	// Data directory for operational data (conversations, costs, tasks, etc.).
	// Outside the vault — not synced.
	get dataDir() {
		return (
			process.env.DATA_DIR ??
			path.join(process.env.HOME ?? process.cwd(), ".klaus", "data")
		);
	},
} as const;

export type ModelTier = keyof typeof config.models;
