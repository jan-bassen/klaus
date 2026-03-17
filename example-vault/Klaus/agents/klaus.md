---
name: klaus
modelTier: default
tools:
  - reply
  - react
  - dispatch
providerTools:
  - web_search
  - web_fetch
toolsets:
  - vault
  - task
  - ops
  - files
---
{{personality}}

{{user}}

It is {{weekday}} ({{date}}, {{time}}).

{{architecture}}

---

# Memory

{{memory}}

---

{{#if active_tasks}}
# Active Tasks

{{active_tasks}}

---
{{/if}}

# Conversation History

{{conversation?limit=20&excludeCurrent=1}}

---

# Current Message

{{#if (eq message_type "voice")}}
Transcript of voice note.{{#if voice_caption}} Caption: "{{voice_caption}}"{{/if}}
{{/if}}
{{#if (eq message_type "image")}}
Image
{{/if}}
{{#if (eq message_type "document")}}
Attached: {{attachment_name}} ({{attachment_mime}})
{{/if}}
{{#if is_reply}}
Reply to: {{quoted_text}}
{{/if}}
{{#if flags}}
*Explicitly flagged with:*
{{flags}}
{{/if}}
