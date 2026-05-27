**Agent**: `{{agent}}`
**Time**: `{{timestamp}}`
**Run**: `{{runId}}`
**Chat**: `{{chatId}}`
**Trigger**: {{trigger.kind}}{{#if trigger.messageId}} `{{trigger.messageId}}`{{/if}}{{#if trigger.scheduleId}} `{{trigger.scheduleId}}`{{/if}}{{#if trigger.timerId}} `{{trigger.timerId}}`{{/if}}{{#if trigger.parentRunId}} parent `{{trigger.parentRunId}}`{{/if}}
**Duration**: {{durationMs}}ms
**Outcome**: {{outcome.kind}}{{#if outcome.error}} — `{{outcome.error.name}}: {{outcome.error.message}}`{{/if}}
{{#if overrides.length}}**Overrides**: {{join overrides ", "}}
{{/if}}**Config**: {{config.provider}}/{{config.modelTier}}{{#if config.historyLimit}}, history {{config.historyScope}}/{{config.historyLimit}}{{/if}}
{{#if llm}}
**Tokens**: {{llm.usage.promptTokens}} in / {{llm.usage.completionTokens}} out
**Prompt**: {{llm.systemPromptChars}} chars system + {{llm.userMessageChars}} chars user, {{llm.historyMessageCount}} history msgs
**Message**: {{llm.replyChars}} chars

### Context
**Variables**
```
{{#if llm.context.variables.length}}{{join llm.context.variables ", "}}{{else}}none{{/if}}
```
**Tools**
```
{{#if llm.context.tools.length}}{{join llm.context.tools ", "}}{{else}}none{{/if}}
```
**Toolsets**
```
{{#if llm.context.toolsets.length}}{{join llm.context.toolsets ", "}}{{else}}none{{/if}}
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
### Steps
{{#each llm.steps}}
{{#if toolCalls.length}}
### Step {{inc @index}}
{{#if usage}}({{usage.inputTokens}}↑/{{usage.outputTokens}}↓)

{{/if}}{{#if reasoning}}
**Reasoning**
{{codeFence (trunc reasoning 800)}}

{{/if}}
{{#each toolCalls}}
**Tool call: {{tool}}**
`{{trunc (json args) 240}}`

{{/each}}
{{#each toolResults}}
**Tool result: {{tool}}**
{{codeFence (trunc (json result) 1200)}}

{{/each}}
{{else}}
### Finish{{#if finishReason}} ({{finishReason}}){{/if}}
{{#if usage}}({{usage.inputTokens}}↑/{{usage.outputTokens}}↓)

{{/if}}
{{#if reasoning}}
**Reasoning**
{{codeFence (trunc reasoning 800)}}

{{/if}}
{{#if fallback}}`{{fallback}}`{{/if}}
{{/if}}
{{/each}}
{{#if llm.assistantMessage}}

### Output
{{codeFence llm.assistantMessage}}
{{/if}}
{{/if}}
