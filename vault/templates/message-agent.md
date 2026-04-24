{{#if (and showTrace steps.length)}}[@{{agent}} used {{#each steps}}{{#each calls}}{{~> message-tool ~}}{{#unless @last}}, {{/unless}}{{/each}}{{#unless @last}}, {{/unless}}{{/each}} → replied]
{{/if}}{{text}}
