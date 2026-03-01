
# TODO yet: 
- rely only on anthropic for llm, embeddings, and vision plus elevenlabs for voice! Remove openAI, and use preexisting tools for search, etc

# Next progress steps:
Here's what's done and what's left, mapped to the pipeline:
*Done (implemented + tested):*
- Pipeline step 1: middleware.checkAllowlist
- Pipeline step 2: rate-limiter (both gates)
- Pipeline step 3: middleware.debounce
- Pipeline step 5: whatsapp/flags.ts (parseFlags, stripFlags)
- Pipeline step 5-6: whatsapp/commands.ts (parseCommand, CommandRegistry)
- DB: write.ts, search.ts, schema, migrations
  
*Still stubbed (22 files):* everything else -- agent loading, model router, context assembly, all tools, all whatsapp transport, pipeline orchestrator, queue/worker.

I'd suggest context/flags.ts (the flagsQuery context query) and core/agent.ts (loadAgentDefinition) as the next pair. Here's the reasoning:

1. context/flags.ts is the natural completion of what you just built. It's the consumer of parseFlags -- it takes the flags map from TurnContext, looks up each flag's promptInjection in FLAG_MAP, and concatenates them into a string. Pure function, no DB, no LLM, trivially testable. It closes the loop on the entire flag feature end-to-end.
2. core/agent.ts -- loadAgentDefinition parses your agent .md files (YAML frontmatter + markdown body) into AgentDefinition objects. You already have 5 agent files in src/agents/. This is still pure parsing (read file, parse YAML, validate against types) with no LLM or DB dependency. It also unlocks pipeline step 6 (routing), since routing needs the agentRegistry populated. You'd need a small YAML parser dep (or use the frontmatter convention with a regex + JSON.parse/manual parse -- Bun doesn't have a built-in YAML parser, so you'd likely bun add yaml).