{{#if isVoice}}>Transcript of voice note<{{#if voiceCaption}} Caption: "{{voiceCaption}}"{{/if}}{{/if}}

{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}
{{/if}}

{{#if label}}[#{{label}}] {{/if}}{{messageText}}

{{#if isImage}}mage{{#if fileName}} ({{fileName}}){{/if}}{{/if}}
{{#if isDocument}}Attached: {{fileName}} ({{mimeType}}){{#if extractedText}}

{{extractedText}}
{{/if}}{{/if}}
