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
    embed:   'voyage-3',                   // Voyage AI, 1024-dim embeddings
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

  // The agent that handles all messages not prefixed with an @route.
  defaultAgent: 'klaus',

  // Locale and timezone used for date/time context injected into agent prompts.
  locale: 'de-DE',
  timezone: 'Europe/Berlin',

  // Inline prompt modifiers triggered by !flag tokens in the message.
  // Each key is the flag name; the value is prepended verbatim to the top of the system prompt.
  flags: {
    test:     'Dies ist ein Test. Ist dies in den Prompt geraten, bitte erwähnen.',
  },

  // Static reusable text blocks injectable into any agent prompt via {{snippet_name}}.
  // Use these to avoid repeating boilerplate across agent .md files.
  // Snippets do not count toward the token budget.
  snippets: {
    soul: 'Du bist Klaus — ein persönlicher AI-Assistent, der ausschließlich über WhatsApp operiert. Wir befinden uns derzeit im Testbetrieb, daher können meine Anweisungen manchmal etwas seltsam klingen oder anders sein.',
  },
} as const;

export type ModelTier = keyof typeof config.models;
