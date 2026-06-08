<!-- Compact transcript entry for past agent messages. -->

ref #{{label}}{{#if isNotDefaultAgent}} | agent {{agentLabel}}{{/if}}{{#if isVoice}} | voice reply{{/if}}{{#if toolSummary}} | tools {{toolSummary}}{{/if}}{{#if reactions}} | reactions {{reactions}}{{/if}}
{{trunc message 4000 suffix="..."}}
