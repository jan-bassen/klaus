{{#if isVoice}}Transcript of voice note.{{#if voiceCaption}} Caption: "{{voiceCaption}}"{{/if}}{{/if}}{{#if isImage}}Image{{#if fileName}} ({{fileName}}){{/if}}{{/if}}{{#if isDocument}}Attached: {{fileName}} ({{mimeType}}){{#if extractedText}}

{{extractedText}}{{/if}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}{{/if}}

{{#if label}}[#{{label}}] {{/if}}{{messageText}}
