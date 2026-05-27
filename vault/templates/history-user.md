ref #{{label}}{{#if isVoice}} | voice transcript{{#if voiceCaption}}; caption: "{{voiceCaption}}"{{/if}}{{/if}}{{#if isImage}} | image{{#if fileName}} {{fileName}}{{/if}}{{/if}}{{#if isDocument}} | attachment {{fileName}} ({{mimeType}}){{/if}}{{#if reactions}} | reactions {{reactions}}{{/if}}
{{#if isDocument}}{{#if extractedText}}

{{extractedText}}{{/if}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{quotedText}}{{/if}}

{{messageText}}
