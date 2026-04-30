{{#if isVoice}}>Transcript of voice note<{{#if voiceCaption}} Caption: "{{voiceCaption}}"{{/if}}
{{else if isImage}}Image{{#if fileName}} ({{fileName}}){{/if}}
{{else if isDocument}}Attached: {{fileName}} ({{mimeType}}){{#if extractedText}}

{{extractedText}}
{{/if}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}
{{/if}}

{{#if label}}[#{{label}}] {{/if}}{{messageText}}
