# Provider Routing & Model Variants

## Model Variant Suffixes

Append these suffixes to any model ID to modify behavior:

| Suffix | Purpose | Example |
|--------|---------|---------|
| `:thinking` | Extended reasoning for complex tasks | `deepseek/deepseek-r1:thinking` |
| `:free` | Free version (may have rate limits) | `meta-llama/llama-3.2-3b-instruct:free` |
| `:nitro` | High-speed, throughput-optimized | `openai/gpt-5.2:nitro` |
| `:extended` | Larger context window | `anthropic/claude-sonnet-4.5:extended` |
| `:online` | Real-time web search enabled | `openai/gpt-5.2:online` |
| `:exacto` | Optimized for tool-calling accuracy | `moonshotai/kimi-k2-0905:exacto` |

### Shortcut Suffixes

| Suffix | Equivalent To |
|--------|--------------|
| `:floor` | `provider.sort: "price"` |
| `:nitro` | `provider.sort: "throughput"` |
| `:online` | `plugins: [{ id: "web" }]` |

## Provider Preferences

```typescript
{
  provider: {
    // Fallback behavior
    allow_fallbacks: true,           // Use backup providers on failure (default: true)
    require_parameters: false,       // Only use providers supporting all params

    // Provider selection
    order: ["OpenAI", "Anthropic"],  // Ordered preference list
    only: ["OpenAI", "Google"],      // Whitelist (allow only these)
    ignore: ["Groq"],                // Blacklist (never use these)

    // Performance sorting
    sort: "price" | "throughput" | "latency",
    // Advanced sorting:
    sort: {
      by: "price" | "throughput" | "latency",
      partition: "model" | "none"    // "none" = sort across all endpoints
    },

    // Cost constraints
    max_price: {
      prompt: 1,      // Max $/M input tokens
      completion: 2,  // Max $/M output tokens
      image: 0.01,
      request: 0.001
    },

    // Performance constraints
    preferred_min_throughput: 100,   // tokens/sec (applies to p50)
    // Or with percentiles:
    preferred_min_throughput: { p50: 100, p90: 80 },

    preferred_max_latency: 1.5,      // seconds (applies to p50)
    // Or with percentiles:
    preferred_max_latency: { p50: 1.5, p99: 2.5 },

    // Privacy & compliance
    data_collection: "allow" | "deny",    // Provider data retention policy
    zdr: true,                            // Zero Data Retention only
    enforce_distillable_text: true,       // Only models allowing distillation

    // Model quantization
    quantizations: ["int4", "int8", "fp8", "fp16", "bf16", "fp32"]
  }
}
```

## Model Fallbacks

Specify backup models if the primary fails:

```typescript
{
  model: "anthropic/claude-sonnet-4.5",  // Primary model
  models: [                               // Fallback chain
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.2",
    "google/gemini-3-pro"
  ]
}
```

Fallback triggers:
- Context length exceeded
- Moderation flags
- Rate limiting
- Provider downtime

The response includes which model was actually used in the `model` field.

## Auto Router

Use `openrouter/auto` to automatically select the optimal model:

```typescript
{
  model: "openrouter/auto",
  messages: [...],
  plugins: [{
    id: "auto-router",
    allowed_models: [
      "anthropic/*",      // All Anthropic models
      "openai/gpt-5*",    // GPT-5 variants
      "google/*"          // All Google models
    ]
  }]
}
```

Default models: Claude Sonnet 4.5, Claude Opus 4.5, GPT-5.1, Gemini 3 Pro, DeepSeek 3.2

## Body Builder

Generate parallel requests for multiple models:

```typescript
{
  model: "openrouter/bodybuilder",
  messages: [{ role: "user", content: "Compare 3 models on this task..." }]
}
```

Returns array of request bodies to execute in parallel:

```typescript
const bodies = await callBodyBuilder(prompt);
const responses = await Promise.all(
  bodies.map(body => callOpenRouter(body))
);
```

## Available Providers

Major providers include: OpenAI, Anthropic, Google, Google AI Studio, DeepSeek, Mistral, Groq, Together, Fireworks, Amazon Bedrock, Amazon Nova, Azure, xAI, Cohere, Perplexity, SambaNova, Cerebras, and many more.

See the full list at: https://openrouter.ai/docs/api/api-reference/providers/list-providers

## Default Routing Behavior

Without explicit preferences:
1. Load balancing across providers by price (inverse square weighting)
2. Provider A at $1/M is 9x more likely than Provider C at $3/M
3. Prioritizes providers without recent outages (30-second window)
4. Automatic fallback on 5xx errors or rate limits

## Examples

### Cost-Optimized with Performance Floor

```typescript
{
  model: "anthropic/claude-sonnet-4.5",
  provider: {
    sort: "price",
    preferred_min_throughput: { p50: 50 },
    max_price: { prompt: 3, completion: 15 }
  }
}
```

### Speed-Optimized

```typescript
{
  model: "openai/gpt-5.2:nitro",
  // Or equivalently:
  model: "openai/gpt-5.2",
  provider: { sort: "throughput" }
}
```

### Privacy-First

```typescript
{
  model: "anthropic/claude-sonnet-4.5",
  provider: {
    data_collection: "deny",
    zdr: true
  }
}
```

### Specific Provider

```typescript
{
  model: "meta-llama/llama-3.3-70b-instruct",
  provider: {
    order: ["Groq"],           // Try Groq first
    allow_fallbacks: false     // Don't fall back to other providers
  }
}
```
