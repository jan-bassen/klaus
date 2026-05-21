{{#if tasks.active.length}}Context:
- Active tasks:
{{#each tasks.active}}
  {{#if (eq kind "schedule")}}- [schedule {{pattern}}{{#if label}} ({{label}}){{/if}}] {{objective}}{{else}}- [timer {{runAt}}] {{objective}}{{/if}}
{{/each}}

{{/if}}
{{#if isVoice}}[Transcript of voice note{{#if voiceCaption}}; caption: "{{voiceCaption}}"{{/if}}]{{/if}}{{#if isImage}}[Image{{#if fileName}}: {{fileName}}{{/if}}]{{/if}}{{#if isDocument}}[Attached: {{fileName}} ({{mimeType}})]{{#if extractedText}}

{{extractedText}}{{/if}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}{{/if}}

{{#if label}}[#{{label}}] {{/if}}{{messageText}}
