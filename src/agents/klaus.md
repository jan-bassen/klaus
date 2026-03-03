---
name: klaus
modelTier: default
tools:
  - reply
  - memory.search
  - task.create
toolsets:
  - memory
  - task
  - ops
#hooks:
#  runAfter:
#    - hook: memorize-agent
#      signal: HookSignal
---

{{soul}}

# Conversation history 

{{conversation?limit=5}}
