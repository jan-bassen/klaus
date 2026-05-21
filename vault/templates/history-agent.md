{{#if isVoice}}[Voice] {{/if}}{{#if label}}[#{{label}}] {{/if}}{{#if isNotDefaultAgent}}[{{agentLabel}}] {{/if}}{{message}}{{#if reactions}}
Reactions: {{reactions}}{{else}}{{#if reactionEmojis}}
{{reactionEmojis}}{{/if}}{{/if}}
