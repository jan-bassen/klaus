{{#if tasks.active.length}}Context:
- Active tasks:
{{#each tasks.active}}
  {{#if (eq kind "schedule")}}- schedule {{pattern}}{{#if label}} ({{label}}){{/if}}: {{objective}}{{else}}- timer {{runAt}}: {{objective}}{{/if}}
{{/each}}

{{/if}}
{{#if isVoice}}input: voice transcript{{#if voiceCaption}}; caption: "{{voiceCaption}}"{{/if}}{{/if}}{{#if isImage}}input: image{{#if fileName}} {{fileName}}{{/if}}{{/if}}{{#if isDocument}}input: attachment {{fileName}} ({{mimeType}}){{#if extractedText}}

{{extractedText}}{{/if}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}{{/if}}

{{messageText}}
