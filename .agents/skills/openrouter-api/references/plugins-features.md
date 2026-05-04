# Plugins & Advanced Features

## Available Plugins

| Plugin ID | Purpose | Use Case |
|-----------|---------|----------|
| `web` | Real-time web search | Current events, latest news |
| `file-parser` | PDF/document processing | Extract text from PDFs |
| `response-healing` | Auto-fix malformed JSON | Robust JSON parsing |
| `auto-router` | Automatic model selection | Optimal model routing |

## Web Search Plugin

```typescript
{
  model: "openai/gpt-5.2",
  messages: [...],
  plugins: [{
    id: "web",
    enabled: true,           // Default: true
    max_results: 5,          // Number of search results
    search_prompt: "...",    // Custom search query (optional)
    engine: "native" | "exa" // Search engine
  }]
}
```

Shortcut: Use `:online` suffix instead:
```typescript
model: "openai/gpt-5.2:online"
```

## File Parser Plugin

```typescript
{
  plugins: [{
    id: "file-parser",
    enabled: true,
    pdf: {
      engine: "native" | "mistral-ocr" | "pdf-text"
    }
  }]
}
```

PDF engines:
- `native`: Model's built-in PDF handling
- `mistral-ocr`: Mistral OCR for scanned documents
- `pdf-text`: Simple text extraction

## Response Healing Plugin

Automatically fixes malformed JSON responses:

```typescript
{
  plugins: [{
    id: "response-healing",
    enabled: true
  }]
}
```

Useful with `response_format: { type: "json_object" }` for reliable JSON output.

## Disabling Default Plugins

If a plugin is enabled by default at the account level:

```typescript
{
  plugins: [{
    id: "web",
    enabled: false  // Disable for this request
  }]
}
```

---

## Structured Outputs

### JSON Object Mode

```typescript
{
  response_format: {
    type: "json_object"
  }
}
```

### JSON Schema Mode (Strict)

```typescript
{
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "weather_response",
      strict: true,
      schema: {
        type: "object",
        properties: {
          location: { type: "string" },
          temperature: { type: "number" },
          conditions: { type: "string" },
          forecast: {
            type: "array",
            items: {
              type: "object",
              properties: {
                day: { type: "string" },
                high: { type: "number" },
                low: { type: "number" }
              },
              required: ["day", "high", "low"],
              additionalProperties: false
            }
          }
        },
        required: ["location", "temperature", "conditions"],
        additionalProperties: false
      }
    }
  }
}
```

### Other Formats

```typescript
response_format: { type: "text" }     // Default
response_format: { type: "python" }   // Python code format
response_format: {                    // Grammar-based
  type: "grammar",
  grammar: "..."
}
```

### Supported Models

Structured outputs work with: OpenAI GPT-4o+, Google Gemini, Anthropic Claude 4.x, Fireworks, most open-source models.

---

## Multimodal Inputs

### Images

```typescript
{
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "What's in this image?" },
      {
        type: "image_url",
        image_url: {
          url: "https://example.com/image.jpg",  // Or base64
          detail: "auto" | "low" | "high"
        }
      }
    ]
  }]
}
```

Base64 format:
```typescript
url: "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
```

Supported formats: PNG, JPEG, WebP, GIF

### Audio

```typescript
{
  type: "input_audio",
  input_audio: {
    data: "base64_encoded_audio",
    format: "mp3" | "wav"
  }
}
```

### Video

```typescript
{
  type: "input_video",
  video_url: { url: "https://example.com/video.mp4" }
}
// Or
{
  type: "video_url",
  video_url: { url: "data:video/mp4;base64,..." }
}
```

---

## Message Transforms

### Middle-Out Compression

Compresses long conversations to fit context limits:

```typescript
{
  transforms: ["middle-out"],
  messages: [...]
}
```

Behavior:
- Removes/truncates messages from the middle (LLMs focus less on middle content)
- Falls back to highest context-length model if needed
- Auto-applied for models with ≤8k context (disable with `transforms: []`)

---

## Prompt Caching

### OpenAI (Automatic)

- Minimum 1024 tokens
- Cache reads at 0.25x-0.50x input price
- No configuration needed

### Anthropic (Manual Breakpoints)

```typescript
{
  messages: [{
    role: "user",
    content: [{
      type: "text",
      text: "Large document to cache...",
      cache_control: {
        type: "ephemeral",
        ttl: "5m" | "1h"  // 5 minutes (default) or 1 hour
      }
    }]
  }]
}
```

Maximum 4 cache breakpoints per request.

### DeepSeek, Grok, Moonshot, Groq

Automatic caching, no configuration needed.

### Google Gemini (2.5+ models)

Implicit caching automatic; use `cache_control` for explicit control.

---

## Reasoning Tokens

For thinking/reasoning models:

```typescript
{
  reasoning: {
    effort: "high",        // xhigh, high, medium, low, minimal, none
    summary: "concise",    // auto, concise, detailed
    max_tokens: 5000,      // Direct token allocation (optional)
    enabled: true          // Enable with default (medium) effort
  }
}
```

Effort levels (approximate % of token budget):
- `xhigh`: 95%
- `high`: 80%
- `medium`: 50%
- `low`: 20%
- `minimal`: 10%
- `none`: 0%

Reasoning appears in response as `reasoning` field or `reasoning_details` array.

### Preserving Reasoning for Tool Use

Pass back `reasoning_details` unchanged when continuing tool conversations:

```typescript
messages: [
  previousAssistantMessage,  // Contains reasoning_details
  { role: "tool", tool_call_id: "...", content: "..." }
]
```

---

## Assistant Prefill

Guide model responses by pre-filling the assistant message:

```typescript
{
  messages: [
    { role: "user", content: "What is the meaning of life?" },
    { role: "assistant", content: "The meaning of life is" }
  ]
}
```

Model continues from your prefill.

---

## Beta Headers (Anthropic)

Enable beta features:

```typescript
headers: {
  "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14"
}
```

Available betas:
- `fine-grained-tool-streaming-2025-05-14` - Granular streaming during tool calls
- `interleaved-thinking-2025-05-14` - Interleaved reasoning with output
- `structured-outputs-2025-11-13` - Strict tool use schema validation

Combine multiple:
```typescript
"x-anthropic-beta": "feature1,feature2"
```
