<!-- Per-turn debug report written to Klaus/reports/. This is not sent to the model. -->

**Agent**: `{{agent}}`
**Time**: `{{timestamp}}`
**Run**: `{{runId}}`
**Chat**: `{{chatId}}`
**Trigger**: {{trigger.kind}}{{#if trigger.messageId}} `{{trigger.messageId}}`{{/if}}{{#if trigger.scheduleId}} `{{trigger.scheduleId}}`{{/if}}{{#if trigger.timerId}} `{{trigger.timerId}}`{{/if}}{{#if trigger.parentRunId}} parent `{{trigger.parentRunId}}`{{/if}}
**Duration**: {{durationMs}}ms
**Outcome**: {{outcome.kind}}{{#if outcome.error}} — `{{outcome.error.name}}: {{outcome.error.message}}`{{/if}}
{{#if outcome.error.phase}}**Error phase**: `{{outcome.error.phase}}`
{{/if}}
{{#if overrides.length}}**Overrides**: {{join overrides ", "}}
{{/if}}**Config**: {{#if config.provider}}{{config.provider}}{{else}}unknown{{/if}}/{{#if config.modelTier}}{{config.modelTier}}{{else}}unknown{{/if}}{{#if config.historyLimit}}, history {{config.historyScope}}/{{config.historyLimit}}{{/if}}
{{#if outcome.error.userMessage}}

### User-facing error
{{codeFence outcome.error.userMessage}}
{{/if}}
{{#if outcome.error.stack}}

### Stack
{{codeFence outcome.error.stack}}
{{/if}}
{{#if llm}}
**Model**: {{llm.model}} ({{llm.tier}})
**Tokens**: {{llm.usage.promptTokens}} in / {{llm.usage.completionTokens}} out
**Prompt**: {{llm.systemPromptChars}} chars system + {{llm.userMessageChars}} chars user, {{llm.historyMessageCount}} history msgs
**Message**: {{llm.replyChars}} chars

{{#if llm.assistantMessage}}
### Output
{{codeFence llm.assistantMessage}}
{{/if}}

### Steps
{{#each llm.steps}}
{{#if (or toolCalls.length serverToolUse citations.length)}}
### Step {{inc @index}}
{{#if usage}}({{usage.inputTokens}}↑/{{usage.outputTokens}}↓)

{{/if}}{{#if reasoning}}
**Reasoning**
{{codeFence (trunc reasoning 800)}}

{{/if}}
{{#if fallback}}`{{fallback}}`

{{/if}}
{{#if serverToolUse}}
**Server tool use**
`{{json serverToolUse}}`

{{/if}}
{{#if citations.length}}
**Citations**
{{#each citations}}
- {{#if title}}{{title}} — {{/if}}{{url}}{{#if content}}: {{trunc content 240}}{{/if}}
{{/each}}

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
{{#if llm.userMessage}}

### User message
{{codeFence llm.userMessage}}
{{/if}}
{{#if llm.historyTranscript.length}}

### History
{{#each llm.historyTranscript}}
**{{role}}**
{{codeFence (json content)}}
{{/each}}
{{/if}}

### System
{{codeFence llm.systemPrompt}}

### Context
**Variables**
```
{{#if llm.context.variables.length}}{{join llm.context.variables ", "}}{{else}}none{{/if}}
```
**Tools**
```
{{#if llm.context.tools.length}}{{join llm.context.tools ", "}}{{else}}none{{/if}}
```
**Server tools**
```
{{#if llm.context.serverTools.length}}{{join llm.context.serverTools ", "}}{{else}}none{{/if}}
```
**Toolsets**
```
{{#if llm.context.toolsets.length}}{{join llm.context.toolsets ", "}}{{else}}none{{/if}}
```
**Skills**
```
{{#if llm.context.skills.length}}{{join llm.context.skills ", "}}{{else}}none{{/if}}
```
{{/if}}
