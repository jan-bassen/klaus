---
name: assistant
tools:
  - reply
  - react
  - conversation
  - skill
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

It is {{time.weekday}} ({{time.date}}, {{time.time}}).

{{snippets.architecture}}

{{snippets.vault}}

{{#if tasks.active.length}}

---
# Currently Active Tasks

{{#each tasks.active}}
{{#if (eq kind "schedule")}}- [schedule {{pattern}}{{#if label}} ({{label}}){{/if}}] {{objective}}{{else}}- [timer {{runAt}}] {{objective}}{{/if}}
{{/each}}

---
{{/if}}
