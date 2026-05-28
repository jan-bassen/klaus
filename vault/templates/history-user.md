ref #{{label}}{{#if isVoice}} | voice transcript{{/if}}{{#if isImage}} | image{{#if fileName}} {{fileName}}{{/if}}{{/if}}{{#if isDocument}} | attachment {{fileName}} ({{mimeType}}){{/if}}{{#if reactions}} | reactions {{reactions}}{{/if}}
{{#if quotedText}}> Quoted{{#if quotedRole}} ({{quotedRole}}){{/if}}: {{trunc quotedText 1000 suffix="..."}}{{/if}}

{{#if isDocument}}{{trunc messageText 1000 suffix="..."}}{{else}}{{trunc messageText 4000 suffix="..."}}{{/if}}
{{#if isDocument}}{{#if extractedText}}

Extracted text:
{{trunc extractedText 3000 suffix="..."}}{{/if}}{{/if}}
