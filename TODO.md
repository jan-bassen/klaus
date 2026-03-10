# TODO

## Polish
- Finish cost tracking: add tracking for remaining apis (eg stt), use correct costs: tts $0.12/1k characters | stt $0.39/h | embed $0.06/million tokens (with 200m free tokens but that could be ignored if too complex to implement) + see point below for generalized cost tracking (move cost from invocation to that table)
- Clean up db (two migration files: 1 manual for plugins etc, 2 grenerated for tables) and rename llm_budgets to generalized budgets table and same with costs. rename agent_invocations to just invocations.

## Skills
- Add a new primitive for dynamically loaded md content
- Add a new core tool for retrieving said skills

## Evals
- Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- See `AGENT.md` for eval conventions
