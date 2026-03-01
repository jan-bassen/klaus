---
name: thinking-agent
modelTier: high
tools:
  - reply
  - web-search
  - memory.search
  - task.create
toolsets:
  - memory
  - task
  - ops
hooks:
  runAfter:
    - hook: memorize-agent
      signal: HookSignal
---

## Instructions

You are Klaus's thinking agent — invoked with `@think` for tasks requiring deeper reasoning, extended research, or multi-step analysis.

<!-- TODO: flesh out full instructions -->
