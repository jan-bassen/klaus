- **Agent**: `{{agent}}`
- **Time**: `{{timestamp}}`
- **Run**: `{{runId}}`
- **Chat**: `{{chatId}}`
- **Trigger**: {{trigger.kind}}{{#if trigger.messageId}} `{{trigger.messageId}}`{{/if}}{{#if trigger.scheduleId}} `{{trigger.scheduleId}}`{{/if}}{{#if trigger.timerId}} `{{trigger.timerId}}`{{/if}}{{#if trigger.parentRunId}} parent `{{trigger.parentRunId}}`{{/if}}
- **Duration**: {{durationMs}}ms
- **Outcome**: {{outcome.kind}}{{#if outcome.error}} — `{{outcome.error.name}}: {{outcome.error.message}}`{{/if}}
{{#if simulation}}- ⚠ **SIMULATION** — no real side effects
{{/if}}{{#if overrides.length}}- **Overrides**: {{join overrides ", "}}
{{/if}}- **Config**: {{config.provider}}/{{config.modelTier}}{{#if config.historyLimit}}, history {{config.historyScope}}/{{config.historyLimit}}{{/if}}

{{#if message}}
## Message
{{#if message.text}}> {{trunc message.text 500}}
{{/if}}{{#if message.hasMedia}}- Media: {{message.mediaType}}
{{/if}}{{/if}}

{{#if llm}}
## LLM
- **Model**: {{llm.provider}} / {{llm.model}} ({{llm.tier}})
- **Tokens**: {{llm.usage.promptTokens}} in / {{llm.usage.completionTokens}} out
- **Prompt**: {{llm.systemPromptChars}} chars system + {{llm.userMessageChars}} chars user, {{llm.historyMessageCount}} history msgs
- **Reply**: {{llm.replyChars}} chars
- **Steps**: {{llm.steps.length}}

{{#each llm.steps}}
### Step {{@index}}{{#if finishReason}} — `{{finishReason}}`{{/if}}{{#if usage}} — {{usage.inputTokens}}↑/{{usage.outputTokens}}↓{{/if}}
{{#if reasoning}}
> {{trunc reasoning 800}}
{{/if}}{{#each toolCalls}}
- **{{tool}}** `{{trunc (json args) 240}}`
{{/each}}
{{/each}}

{{#if variablesSummary}}
## Variables
{{#each variablesSummary}}
- {{@key}}: {{this}} chars
{{/each}}
{{/if}}

{{#if simulatedActions.length}}
## Simulated actions
{{#each simulatedActions}}
- **{{tool}}** ({{sideEffect}}) — {{intent}}
{{/each}}
{{/if}}

{{#if llm.systemPrompt}}
### System prompt
```
{{llm.systemPrompt}}
```
{{/if}}
{{#if llm.userMessage}}
### User message
```
{{llm.userMessage}}
```
{{/if}}
{{#if llm.historyTranscript.length}}
### History transcript
{{#each llm.historyTranscript}}
**{{role}}**
```
{{json content}}
```
{{/each}}
{{/if}}
{{/if}}
