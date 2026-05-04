# Chat Completions API Reference

## Endpoint

```
POST https://openrouter.ai/api/v1/chat/completions
```

## Authentication

```
Authorization: Bearer <OPENROUTER_API_KEY>
```

Optional headers for app identification:
- `HTTP-Referer: <YOUR_SITE_URL>` - For rankings on openrouter.ai
- `X-Title: <YOUR_SITE_NAME>` - Custom app title

## Request Body

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `messages` | Message[] | Conversation history |

### Core Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | user default | Model ID (e.g., `openai/gpt-5.2`, `anthropic/claude-sonnet-4.5`) |
| `stream` | boolean | false | Enable streaming responses |
| `max_tokens` | number | - | Maximum completion tokens [1, context_length) |
| `temperature` | number | 1.0 | Randomness [0, 2] |
| `top_p` | number | 1.0 | Nucleus sampling (0, 1] |

### Advanced Sampling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `top_k` | number | - | Limit choices to K most likely tokens |
| `min_p` | number | - | Minimum probability relative to most likely [0, 1] |
| `top_a` | number | - | Dynamic top-P based on max probability [0, 1] |
| `frequency_penalty` | number | 0 | Reduce repetition of tokens (scales with occurrences) [-2, 2] |
| `presence_penalty` | number | 0 | Reduce repetition of any used token [-2, 2] |
| `repetition_penalty` | number | 1.0 | Reduce token repetition from input (0, 2] |
| `seed` | number | - | For deterministic outputs |

### OpenRouter-Specific

| Field | Type | Description |
|-------|------|-------------|
| `models` | string[] | Fallback models (tried in order if primary fails) |
| `route` | "fallback" \| "sort" | Routing strategy |
| `provider` | ProviderPreferences | Provider routing preferences |
| `plugins` | Plugin[] | Enable plugins (web search, PDF parsing, etc.) |
| `transforms` | string[] | Message transforms (e.g., "middle-out") |
| `user` | string | End-user identifier for tracking |
| `session_id` | string | Group related requests (max 128 chars) |

### Reasoning (for thinking models)

```typescript
reasoning: {
  effort: "xhigh" | "high" | "medium" | "low" | "minimal" | "none",
  summary: "auto" | "concise" | "detailed",
  max_tokens?: number,  // Direct token allocation
  enabled?: boolean     // Enable with default (medium) effort
}
```

## Message Format

### Basic Messages

```typescript
// System message
{ role: "system", content: "You are a helpful assistant." }

// User message
{ role: "user", content: "Hello!" }

// Assistant message
{ role: "assistant", content: "Hi there!" }

// Developer message (OpenAI-style)
{ role: "developer", content: "Instructions for the model." }
```

### Multimodal Content

```typescript
{
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    {
      type: "image_url",
      image_url: {
        url: "https://..." or "data:image/jpeg;base64,...",
        detail: "auto" | "low" | "high"
      }
    }
  ]
}
```

### Cache Control (Anthropic)

```typescript
{
  role: "user",
  content: [
    {
      type: "text",
      text: "Large context to cache...",
      cache_control: { type: "ephemeral", ttl: "5m" | "1h" }
    }
  ]
}
```

## Response Format

### Non-Streaming Response

```typescript
{
  id: string,                    // Generation ID
  choices: [{
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | "error",
    native_finish_reason: string,
    message: {
      role: "assistant",
      content: string | null,
      tool_calls?: ToolCall[],
      reasoning?: string,
      reasoning_details?: ReasoningBlock[]
    }
  }],
  created: number,
  model: string,                 // Actual model used
  object: "chat.completion",
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
    cost?: number,
    is_byok?: boolean,
    prompt_tokens_details?: {
      cached_tokens: number,
      cache_write_tokens?: number
    },
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}
```

## Code Examples

### Python (requests)

```python
import requests

response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "openai/gpt-5.2",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello!"}
        ],
        "temperature": 0.7,
        "max_tokens": 500
    }
)

data = response.json()
print(data["choices"][0]["message"]["content"])
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY
)

response = client.chat.completions.create(
    model="openai/gpt-5.2",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### TypeScript (@openrouter/sdk)

```typescript
import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const response = await client.chat.send({
    model: 'openai/gpt-5.2',
    messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(response.choices[0].message.content);
```

### JavaScript (fetch)

```javascript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: 'openai/gpt-5.2',
        messages: [{ role: 'user', content: 'Hello!' }]
    })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

## Error Handling

| Status | Description |
|--------|-------------|
| 400 | Bad Request - invalid parameters |
| 401 | Unauthorized - invalid API key |
| 402 | Payment Required - insufficient credits |
| 403 | Forbidden - moderation flag |
| 408 | Request Timeout |
| 429 | Too Many Requests - rate limited |
| 502 | Bad Gateway - provider down |
| 503 | Service Unavailable - no available provider |

Error response format:

```typescript
{
  error: {
    code: number,
    message: string,
    metadata?: {
      reasons?: string[],
      flagged_input?: string,
      provider_name?: string
    }
  }
}
```
