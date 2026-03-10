import path from 'node:path';

export const config = {
  // Model tier map — change model IDs here to swap providers/versions globally.
  // Each tier is referenced by name throughout the codebase; no other file hardcodes model IDs.
  models: {
    default: 'claude-sonnet-4-20250514',   // main conversational agent
    low:     'claude-haiku-3-20250307',    // lightweight tasks, cheap calls
    high:    'claude-opus-4-20250514',     // @think — deep reasoning
    tts:     'eleven_multilingual_v2',     // ElevenLabs TTS
    stt:     'scribe_v1',                  // ElevenLabs Scribe STT
    vision:  'claude-sonnet-4-20250514',   // image analysis (Claude)
    embed:   'voyage-4',                   // Voyage AI, 1024-dim embeddings
  },

  // Per-model pricing in USD per million tokens. Used by model-router to compute costUsd.
  // Source: https://platform.claude.com/docs/en/about-claude/pricing (March 2026)
  pricing: {
    'claude-sonnet-4-20250514': { inputPerMTok:  3.00, outputPerMTok: 15.00 },
    'claude-haiku-3-20250307':  { inputPerMTok:  0.25, outputPerMTok:  1.25 },
    'claude-opus-4-20250514':   { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  } as Record<string, { inputPerMTok: number; outputPerMTok: number }>,

  // Per-service pricing for non-LLM API calls. Used to compute costUsd in costs rows.
  apiPricing: {
    tts:   { perMChars: 120.00 }, // ElevenLabs $0.12/1K chars
    embed: { perMTok:     0.06 }, // Voyage AI voyage-4
    stt:   { perHour:     0.39 }, // ElevenLabs Scribe $0.39/hr
  },

  // Token budgets for context assembly. The assembler fills up to totalTokens,
  // then trims lower-priority sections first if everything doesn't fit.
  context: {
    totalTokens:        100_000, // hard cap passed to the model
    conversationTokens:  20_000, // recent message history (trimmed oldest-first)
    graphContextTokens:  40_000, // pinned nodes + search results + edge expansion
    activeTasksTokens:    5_000, // in-flight async tasks
  },

  // Sliding-window rate limits. Two independent gates:
  // 1. messages   — checked by pipeline before any LLM work (blocks floods)
  // 2. modelCalls — checked by model-router per LLM invocation (blocks runaway loops)
  rateLimits: {
    messages:   { max: 30, windowMs: 60_000 }, // 30 inbound messages per minute
    modelCalls: { max: 60, windowMs: 60_000 }, // 60 LLM calls per minute
  },

  // ElevenLabs TTS voice to use for outbound voice messages.
  // Find your voice ID at https://elevenlabs.io/voice-library or in your ElevenLabs dashboard.
  tts: {
    voiceId: 'z1EhmmPwF0ENGYE8dBE6',
  },

  // Nodes whose body exceeds this threshold are split into chunks for embedding.
  // Chunks are a search optimization — search hits are always resolved back to the parent node.
  chunking: {
    thresholdTokens: 800,
  },

  // Retry policy for transient failures in async task jobs.
  retries: {
    max:       3,      // attempts before marking a task failed
    backoffMs: 1_000,  // base delay; actual delay = backoffMs * attempt (linear)
  },

  // Minimum pause after each outbound message before the next one is sent.
  // Prevents consecutive replies from arriving simultaneously.
  send: {
    interMessageDelayMs: 1_500,
  },

  // Timeout for a single LLM generateText() call. If the Anthropic API hangs
  // longer than this, the call is aborted and an LlmTimeoutError is thrown.
  llm: {
    timeoutMs: 120_000, // 2 minutes
  },

  // Timeouts for the startup sequence.
  startup: {
    connectionTimeoutMs: 60_000, // 1 minute to establish WhatsApp connection
  },

  // The agent that handles all messages not prefixed with an @route.
  defaultAgent: 'klaus',

  // Locale and timezone used for date/time context injected into agent prompts.
  locale: 'de-DE',
  timezone: 'Europe/Berlin',

  // Dispatch chain limits. Prevents runaway recursive chains from agents that
  // keep dispatching further agents without bound.
  dispatch: {
    maxChainDepth: 10,
  },

  // Directory where uploaded and downloaded media files are stored.
  // Override with FILES_DIR env var (e.g. to a mounted volume in production).
  files: {
    get dir() { return process.env.FILES_DIR ?? path.join(process.cwd(), '.files'); },
  },
  database: {
    get url() { return process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/klaus'; },
  },
} as const;

export type ModelTier = keyof typeof config.models;
