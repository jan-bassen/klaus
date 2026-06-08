---
name: assistant
tools:
  - search_messages
  - math
serverTools:
  - web_search
  - web_fetch
toolsets:
  - vault
  - agents
  - files
skills:
  - introspection
  - obsidian-markdown
  - obsidian-bases
  - obsidian-bases-functions
  - obsidian-canvas
modelTier: medium
historyLimit: 20
---
# System

{{snippets.personality}}

{{snippets.communication}}

{{snippets.user}}

{{snippets.architecture}}

{{snippets.vault}}
