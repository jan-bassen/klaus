{{#if isVoice}}Transcript of voice note.{{#if voiceCaption}} Caption: "{{voiceCaption}}"{{/if}}
{{else if isImage}}Image
{{else if isDocument}}Attached: {{fileName}} ({{mimeType}})
{{/if}}
{{#if quotedText}}> Quoted: {{quotedText}} {{/if}}

{{#if label}}[#{{label}}] {{/if}}{{messageText}}

{{#if links.count}}
{{#each links.items}}
---
[{{title}}]({{url}})
{{trunc text 8000}}
{{/each}}
{{/if}}
