---
name: assistant
modelTier: medium
tools:
  - reply
  - react
providerTools:
  - web_search
toolsets:
  - vault
  - dispatch
  - files
skills:
  - obsidian-markdown
  - obsidian-bases
  - obsidian-bases-functions
  - obsidian-canvas
conversationLimit: 20
---
{{snippets.personality}}

{{snippets.communication}}

{{snippets.user}}

It is {{time.weekday}} ({{time.date}}, {{time.time}}).

{{snippets.architecture}}

{{snippets.vault}}

{{#if tasks.active.length}}

---
# Currently Active Tasks

{{#each tasks.active}}
{{#if (eq kind "running")}}- [running] {{objective}}{{else}}- [timer {{runAt}}] {{objective}}{{/if}}
{{/each}}

---
{{/if}}
