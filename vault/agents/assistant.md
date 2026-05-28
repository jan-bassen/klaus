---
name: assistant
tools:
  - send_message
  - set_reaction
  - search_messages
  - send_image
  - math
serverTools:
  - web_search
  - web_fetch
toolsets:
  - vault
  - agents
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
