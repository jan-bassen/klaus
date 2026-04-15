{{#if (eq media.kind "voice")}}Transcript of voice note.{{#if media.voice.caption}} Caption: "{{media.voice.caption}}"{{/if}}
{{else if (eq media.kind "image")}}Image
{{else if (eq media.kind "doc")}}Attached: {{media.doc.name}} ({{media.doc.mime}}){{#if media.doc.text}}
```
{{media.doc.text}}
```{{/if}}
{{/if}}
{{#if quotedText}}> Quoted: {{quotedText}}{{/if}}

{{messageText}}