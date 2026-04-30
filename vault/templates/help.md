{{#if settings}}
*Settings*

agent: @{{settings.agent}}
{{#if settings.model}}model: _{{settings.model}}_
{{/if}}{{#if settings.voice}}voice: _{{settings.voice}}_
{{/if}}{{#if settings.report}}report: _{{settings.report}}_
{{/if}}{{#if settings.history}}history: _{{settings.history}}_
{{/if}}
{{/if}}

{{#if agents}}
*Agents*

{{#each agents}}
*@{{name}}*{{aliases}}
{{#if tools}}tools: _{{tools}}_
{{/if}}{{#if toolsets}}toolsets: _{{toolsets}}_
{{/if}}model: _{{model}}_
history: _{{history}}_
{{/each}}
{{/if}}

{{#if commands}}
*Commands*

{{#each commands}}
*/{{name}}*{{aliases}}{{#if params}} {{params}}{{/if}}
_{{description}}_
{{/each}}
{{/if}}

{{#if overrides}}
*Overrides*

{{#each overrides}}
*!{{name}}*{{aliases}}
_{{description}}_
{{/each}}
{{/if}}
