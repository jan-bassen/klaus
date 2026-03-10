# TODO

## Agents
- Rebuild other core agent prompts from first principles
- `src/agents/reflection.md` — flesh out daily maintenance instructions (graph health check, duplicate detection, edge decay, tag promotion, orphan detection, pattern synthesis)

## Details
- Add cost tracking for tts and other api calls
- Does pipeline need it's own test command?
- Describe all primitives in README

## Skills
- Add a new primitive for dynamically loaded md content
- Add a new core tool for retrieving said skills

## Evals
- Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- See `AGENT.md` for eval conventions
