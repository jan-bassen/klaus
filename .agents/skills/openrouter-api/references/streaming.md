# Streaming Responses

## Enable Streaming

```typescript
{
  model: "openai/gpt-5.2",
  messages: [...],
  stream: true
}
```

## Server-Sent Events (SSE) Format

Each chunk is prefixed with `data: ` followed by JSON:

```
data: {"id":"gen-xxx","choices":[{"delta":{"content":"Hello"}}],...}
data: {"id":"gen-xxx","choices":[{"delta":{"content":" world"}}],...}
data: {"id":"gen-xxx","choices":[{"finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

Special markers:
- `: OPENROUTER PROCESSING` - Comment to prevent timeouts (ignore these)
- `data: [DONE]` - Stream complete

## Streaming Response Structure

```typescript
{
  id: string,
  choices: [{
    delta: {
      role?: string,         // Only in first chunk
      content?: string,      // Incremental text
      tool_calls?: [{        // Tool call deltas
        index: number,
        id?: string,
        function?: {
          name?: string,
          arguments?: string
        }
      }]
    },
    finish_reason: string | null  // Only in final chunk
  }],
  model: string,
  usage?: {                  // Only in final chunk
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
    cost?: number
  }
}
```

## JavaScript Implementation

### Using fetch

```typescript
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openai/gpt-5.2",
    messages: [{ role: "user", content: "Tell me a story" }],
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";  // Keep incomplete line in buffer

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      const chunk = JSON.parse(data);
      const content = chunk.choices[0]?.delta?.content;
      if (content) process.stdout.write(content);

      // Check for usage in final chunk
      if (chunk.usage) {
        console.log("\n\nUsage:", chunk.usage);
      }
    }
  }
}
```

### Using OpenRouter SDK

```typescript
import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const stream = await client.chat.send({
  model: 'openai/gpt-5.2',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) process.stdout.write(content);

  if (chunk.usage) {
    console.log('\n\nTokens:', chunk.usage.total_tokens);
    console.log('Cost: $', chunk.usage.cost);
  }
}
```

### Using OpenAI SDK

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
});

const stream = await client.chat.completions.create({
  model: 'openai/gpt-5.2',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

## Python Implementation

### Using requests

```python
import requests
import json

response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "openai/gpt-5.2",
        "messages": [{"role": "user", "content": "Tell me a story"}],
        "stream": True
    },
    stream=True
)

for line in response.iter_lines():
    if line:
        line = line.decode('utf-8')
        if line.startswith('data: '):
            data = line[6:]
            if data == '[DONE]':
                break
            chunk = json.loads(data)
            content = chunk['choices'][0].get('delta', {}).get('content', '')
            if content:
                print(content, end='', flush=True)
```

### Using OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY
)

stream = client.chat.completions.create(
    model="openai/gpt-5.2",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True
)

for chunk in stream:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
```

## Stream Cancellation

To cancel an ongoing stream:

### JavaScript

```typescript
const controller = new AbortController();

const response = await fetch(url, {
  method: "POST",
  headers: {...},
  body: JSON.stringify({...}),
  signal: controller.signal
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);
```

### Supported Providers

Stream cancellation is supported by: OpenAI, Anthropic, Fireworks, Groq, and others.

## Error Handling

### Pre-Stream Errors

Standard JSON error response with HTTP status code:

```typescript
if (!response.ok) {
  const error = await response.json();
  console.error(error.error.message);
}
```

### Mid-Stream Errors

Sent as SSE with error field, HTTP remains 200:

```typescript
{
  "choices": [{
    "delta": {},
    "finish_reason": "error"
  }],
  "error": {
    "code": 500,
    "message": "Provider error occurred"
  }
}
```

## Debug Mode

Echo the transformed request body (streaming only):

```typescript
{
  stream: true,
  debug: {
    echo_upstream_body: true
  }
}
```

First chunk will contain the request body sent to the provider. Use only for debugging.

## Usage Stats

Usage statistics are included in the final streaming chunk:

```typescript
{
  "choices": [{"finish_reason": "stop", ...}],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 125,
    "total_tokens": 140,
    "cost": 0.00021
  }
}
```

To ensure usage is included, use `stream_options`:

```typescript
{
  stream: true,
  stream_options: {
    include_usage: true
  }
}
```
