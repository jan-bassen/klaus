---
name: assistant
tools:
  - reply
  - react
  - conversation
  - image_generate
  - math
providerTools:
  - web_search
  - web_fetch
toolsets:
  - vault
  - dispatch
  - files
skills:
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
