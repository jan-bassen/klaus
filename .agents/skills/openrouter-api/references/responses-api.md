# Responses API (Beta)

## Overview

The Responses API is an alternative stateless API format, compatible with OpenAI's Responses API. Each request is independent with no conversation persistence.

## Endpoint

```
POST https://openrouter.ai/api/v1/responses
```

## Request Format

```typescript
{
  // Input (required)
  input: string | InputItem[],

  // Model selection
  model: string,
  models?: string[],           // Fallback models

  // Instructions
  instructions?: string,       // System instructions

  // Response control
  max_output_tokens?: number,
  temperature?: number,
  top_p?: number,
  top_k?: number,
  presence_penalty?: number,
  frequency_penalty?: number,

  // Reasoning
  reasoning?: {
    effort: "xhigh" | "high" | "medium" | "low" | "minimal" | "none",
    summary: "auto" | "concise" | "detailed",
    max_tokens?: number,
    enabled?: boolean
  },

  // Tools
  tools?: Tool[],
  tool_choice?: "auto" | "none" | "required" | { type: "function", name: string },
  parallel_tool_calls?: boolean,

  // Output format
  text?: {
    format: { type: "text" } | { type: "json_object" } | {
      type: "json_schema",
      name: string,
      schema: object,
      strict?: boolean
    },
    verbosity?: "high" | "medium" | "low"
  },

  // Streaming
  stream?: boolean,

  // OpenRouter-specific
  provider?: ProviderPreferences,
  plugins?: Plugin[],
  user?: string,
  session_id?: string,

  // Image generation
  modalities?: ("text" | "image")[],
  image_config?: Record<string, string | number>
}
```

## Input Format

### Simple String

```typescript
{
  input: "Hello, how are you?"
}
```

### Message Array

```typescript
{
  input: [
    {
      type: "message",
      role: "user",
      content: "Hello!"
    },
    {
      type: "message",
      role: "assistant",
      content: "Hi there!"
    },
    {
      type: "message",
      role: "user",
      content: "What's the weather?"
    }
  ]
}
```

### With Content Types

```typescript
{
  input: [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "What's in this image?" },
      {
        type: "input_image",
        image_url: "https://...",
        detail: "auto" | "high" | "low"
      }
    ]
  }]
}
```

### Including Previous Tool Calls

```typescript
{
  input: [
    { type: "message", role: "user", content: "What's the weather?" },
    {
      type: "function_call",
      id: "call_123",
      call_id: "call_123",
      name: "get_weather",
      arguments: '{"location": "NYC"}',
      status: "completed"
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: '{"temp": 72, "conditions": "sunny"}'
    }
  ]
}
```

## Response Format

```typescript
{
  id: string,
  object: "response",
  created_at: number,
  model: string,
  status: "completed" | "incomplete" | "failed" | "cancelled",
  completed_at: number | null,

  output: OutputItem[],
  output_text: string,           // Convenience: concatenated text output

  error?: {
    code: string,
    message: string
  },
  incomplete_details?: {
    reason: "max_output_tokens" | "content_filter"
  },

  usage: {
    input_tokens: number,
    output_tokens: number,
    total_tokens: number,
    input_tokens_details: { cached_tokens: number },
    output_tokens_details: { reasoning_tokens: number },
    cost?: number,
    is_byok?: boolean
  },

  // Echo back request params
  temperature: number | null,
  top_p: number | null,
  max_output_tokens: number | null,
  tools: Tool[],
  tool_choice: ToolChoice,
  // ...
}
```

## Output Items

### Message Output

```typescript
{
  type: "message",
  id: string,
  role: "assistant",
  status: "completed" | "incomplete" | "in_progress",
  content: [{
    type: "output_text",
    text: string,
    annotations?: Annotation[],
    logprobs?: LogProb[]
  }]
}
```

### Function Call Output

```typescript
{
  type: "function_call",
  id: string,
  name: string,
  arguments: string,
  call_id: string,
  status: "completed" | "incomplete" | "in_progress"
}
```

### Reasoning Output

```typescript
{
  type: "reasoning",
  id: string,
  summary: [{ type: "summary_text", text: string }],
  content?: [{ type: "reasoning_text", text: string }],
  encrypted_content?: string,
  signature?: string,
  status: "completed" | "incomplete" | "in_progress"
}
```

### Web Search Output

```typescript
{
  type: "web_search_call",
  id: string,
  status: "completed" | "searching" | "in_progress" | "failed"
}
```

## Tool Definition

```typescript
{
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Get current weather",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" }
        },
        required: ["location"]
      },
      strict: true
    },
    {
      type: "web_search",  // Built-in web search tool
      search_context_size: "low" | "medium" | "high",
      user_location: {
        type: "approximate",
        city: "San Francisco",
        country: "US"
      }
    }
  ]
}
```

## Example Request

```typescript
const response = await fetch("https://openrouter.ai/api/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "anthropic/claude-sonnet-4.5",
    input: [
      { role: "user", content: "Calculate 15% tip on $85.50" }
    ],
    tools: [{
      type: "function",
      name: "calculate",
      description: "Perform calculations",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string" }
        },
        required: ["expression"]
      }
    }],
    reasoning: { effort: "medium" },
    temperature: 0.7
  })
});

const data = await response.json();
console.log(data.output_text);  // Final text response
console.log(data.output);       // Full output items including tool calls
```

## Streaming

```typescript
{
  stream: true
}
```

Streams output items incrementally using SSE format, similar to Chat Completions streaming.

## Key Differences from Chat Completions

| Feature | Chat Completions | Responses API |
|---------|-----------------|---------------|
| State | Stateful conversation | Stateless |
| Input format | `messages` array | `input` (string or items) |
| System prompt | `messages` with `system` role | `instructions` field |
| Output | `choices[0].message` | `output` array + `output_text` |
| Token fields | `prompt_tokens`, `completion_tokens` | `input_tokens`, `output_tokens` |

## When to Use

- Stateless transformations
- Simple request/response workflows
- When you don't need conversation history management
- OpenAI Responses API compatibility
