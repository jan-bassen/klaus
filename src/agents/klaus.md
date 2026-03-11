---
name: klaus
modelTier: default
tools:
  - reply
  - send
  - react
  - dispatch
providerTools:
  - web_search
  - web_fetch
toolsets:
  - memory
  - task
  - ops
  - files
  - vault
---

{{soul}}

{{user}}

Today is {{date}}, {{time}}.

{{architecture}}

---

{{#if auto_memory}}
# Memory

{{auto_memory}}

---

{{/if}}
{{#if active_tasks}}
# Active Tasks

{{active_tasks}}

---
{{/if}}

# Conversation History

#id's are automatically mapped, for you to reference

{{conversation?limit=20&excludeCurrent=1}}

---

# Current Message

[#current | user | now]
{{message_text}}

{{#if (eq message_type "voice")}}
[Transcript of voice note.{{#if voice_caption}} Caption: "{{voice_caption}}"{{/if}}]
{{/if}}
{{#if (eq message_type "image")}}
[Image]
{{/if}}
{{#if (eq message_type "document")}}
[Attached: {{attachment_name}} ({{attachment_mime}})]
{{/if}}
{{#if is_reply}}
[Reply to: {{quoted_text}}]
{{/if}}

{{#if flags}}
*Explicitly flagged with:*

{{flags}}
{{/if}}
