**Agent**: `{{agent}}`
**Time**: `{{timestamp}}`
**Run**: `{{runId}}`
**Chat**: `{{chatId}}`
**Trigger**: {{trigger.kind}}{{#if trigger.messageId}} `{{trigger.messageId}}`{{/if}}{{#if trigger.scheduleId}} `{{trigger.scheduleId}}`{{/if}}{{#if trigger.timerId}} `{{trigger.timerId}}`{{/if}}{{#if trigger.parentRunId}} parent `{{trigger.parentRunId}}`{{/if}}
**Duration**: {{durationMs}}ms
**Outcome**: {{outcome.kind}}{{#if outcome.error}} — `{{outcome.error.name}}: {{outcome.error.message}}`{{/if}}
{{#if simulation}}⚠ **SIMULATION** — no real side effects
{{/if}}{{#if overrides.length}}**Overrides**: {{join overrides ", "}}
{{/if}}**Config**: {{config.provider}}/{{config.modelTier}}{{#if config.historyLimit}}, history {{config.historyScope}}/{{config.historyLimit}}{{/if}}
{{#if llm}}
**Tokens**: {{llm.usage.promptTokens}} in / {{llm.usage.completionTokens}} out
**Prompt**: {{llm.systemPromptChars}} chars system + {{llm.userMessageChars}} chars user, {{llm.historyMessageCount}} history msgs
**Reply**: {{llm.replyChars}} chars

### Context
**Variables**
```
{{#if llm.context.variables.length}}{{join llm.context.variables ", "}}{{else}}none{{/if}}
```
**Tools**
```
{{#if llm.context.tools.length}}{{join llm.context.tools ", "}}{{else}}none{{/if}}
```
**Skills**
```
{{#if llm.context.skills.length}}{{join llm.context.skills ", "}}{{else}}none{{/if}}
```

### System
{{codeFence llm.systemPrompt}}
{{#if llm.historyTranscript.length}}

### History
{{#each llm.historyTranscript}}
**{{role}}**
{{codeFence (json content)}}
{{/each}}
{{/if}}
{{#if llm.userMessage}}

### User message
{{codeFence llm.userMessage}}
{{/if}}
{{#if llm.assistantMessage}}

### Agent messages
{{codeFence llm.assistantMessage}}
{{/if}}

### Steps
{{#each llm.steps}}
{{#if toolCalls.length}}
{{#each toolCalls}}
{{#if @first}}**{{inc @../index}}) {{tool}}**{{#if ../usage}} ({{../usage.inputTokens}}↑/{{../usage.outputTokens}}↓){{/if}}
{{#if ../reasoning}}
> {{trunc ../reasoning 800}}

{{/if}}
{{/if}}`{{trunc (json args) 240}}`

{{/each}}
{{else}}
**{{inc @index}}) assistant**{{#if usage}} ({{usage.inputTokens}}↑/{{usage.outputTokens}}↓){{/if}}{{#if finishReason}} `{{finishReason}}`{{/if}}
{{#if reasoning}}
> {{trunc reasoning 800}}
{{/if}}
{{#if fallback}}`{{fallback}}`{{/if}}
{{/if}}
{{/each}}
{{#if simulatedActions.length}}

### Simulated actions
{{#each simulatedActions}}
- **{{tool}}** ({{sideEffect}}) — {{intent}}
{{/each}}
{{/if}}
{{/if}}
