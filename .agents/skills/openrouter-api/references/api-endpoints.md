# API Endpoints Reference

## Base URL

```
https://openrouter.ai/api/v1
```

## Authentication

All endpoints require Bearer token authentication:

```
Authorization: Bearer <OPENROUTER_API_KEY>
```

---

## Chat & Completions

### Create Chat Completion

```
POST /chat/completions
```

Main endpoint for chat completions. See [chat-completions.md](chat-completions.md).

### Create Response (Beta)

```
POST /responses
```

Stateless Responses API. See [responses-api.md](responses-api.md).

---

## Models

### List Models

```
GET /models
```

Returns all available models with pricing and capabilities.

Response:
```typescript
{
  data: [{
    id: string,                    // e.g., "openai/gpt-5.2"
    name: string,                  // Display name
    description: string,
    context_length: number,
    architecture: {
      input_modalities: string[],  // ["text", "image", "file"]
      output_modalities: string[], // ["text", "image"]
      tokenizer: string
    },
    pricing: {
      prompt: string,              // $/token input
      completion: string,          // $/token output
      request: string,             // Fixed $/request
      image: string,
      web_search: string,
      internal_reasoning: string,
      input_cache_read: string,
      input_cache_write: string
    },
    top_provider: {
      context_length: number,
      max_completion_tokens: number,
      is_moderated: boolean
    },
    supported_parameters: string[] // ["tools", "structured_outputs", ...]
  }]
}
```

Query parameters:
- `supported_parameters=tools` - Filter by supported features

### Get Model

```
GET /models/{model_id}
```

Get details for a specific model.

### List Models (User)

```
GET /models/user
```

List models available to the current user with their settings.

---

## API Key Management

### Get Current Key Info

```
GET /key
```

Check API key credits and rate limit status.

Response:
```typescript
{
  data: {
    label: string,
    usage: number,           // Credits used
    limit: number | null,    // Credit limit (null = unlimited)
    is_free_tier: boolean,
    rate_limit: {
      requests: number,
      interval: string
    }
  }
}
```

### List API Keys

```
GET /keys
```

List all API keys for the account.

### Create API Key

```
POST /keys
```

Create a new API key.

Request:
```typescript
{
  name: string,
  limit?: number,          // Credit limit
  expires_at?: string      // ISO 8601 expiration
}
```

### Update API Key

```
PATCH /keys/{key_id}
```

Update an API key's settings.

### Delete API Key

```
DELETE /keys/{key_id}
```

Delete an API key.

---

## Generations

### Get Generation

```
GET /generation?id={generation_id}
```

Query generation stats after completion.

Response:
```typescript
{
  data: {
    id: string,
    model: string,
    created_at: string,
    tokens_prompt: number,
    tokens_completion: number,
    native_tokens_prompt: number,
    native_tokens_completion: number,
    total_cost: number,
    origin: string,
    usage: {
      prompt_tokens: number,
      completion_tokens: number,
      total_tokens: number
    }
  }
}
```

---

## Credits

### Get Credits

```
GET /credits
```

Get current credit balance and usage.

Response:
```typescript
{
  data: {
    credits: number,
    usage: {
      daily: number,
      weekly: number,
      monthly: number
    }
  }
}
```

### Create Coinbase Charge

```
POST /credits/coinbase
```

Create a Coinbase charge for purchasing credits with crypto.

---

## Analytics

### Get User Activity

```
GET /activity
```

Get usage activity and analytics.

Query parameters:
- `start_date` - Start date (ISO 8601)
- `end_date` - End date (ISO 8601)
- `model` - Filter by model
- `group_by` - Group results by field

---

## Embeddings

### Create Embeddings

```
POST /embeddings
```

Generate embeddings for text.

Request:
```typescript
{
  model: string,           // e.g., "openai/text-embedding-3-small"
  input: string | string[]
}
```

Response:
```typescript
{
  data: [{
    embedding: number[],
    index: number
  }],
  model: string,
  usage: {
    prompt_tokens: number,
    total_tokens: number
  }
}
```

### List Embedding Models

```
GET /embeddings/models
```

List available embedding models.

---

## Providers

### List Providers

```
GET /providers
```

List all available providers with their status.

---

## Endpoints

### List Endpoints

```
GET /endpoints
```

List all model endpoints with provider information.

### List ZDR Endpoints

```
GET /endpoints/zdr
```

List endpoints with Zero Data Retention.

---

## Guardrails

### List Guardrails

```
GET /guardrails
```

List all guardrails for the organization.

### Create Guardrail

```
POST /guardrails
```

Create a new guardrail.

Request:
```typescript
{
  name: string,
  description?: string,
  rules: {
    max_daily_spend?: number,
    max_weekly_spend?: number,
    max_monthly_spend?: number,
    allowed_models?: string[],
    blocked_models?: string[],
    require_zdr?: boolean
  }
}
```

### Update Guardrail

```
PATCH /guardrails/{guardrail_id}
```

Update guardrail settings.

### Delete Guardrail

```
DELETE /guardrails/{guardrail_id}
```

Delete a guardrail.

### Assign Members/Keys

```
POST /guardrails/{guardrail_id}/members
POST /guardrails/{guardrail_id}/keys
```

Assign members or API keys to a guardrail.

---

## OAuth / PKCE Flow

### Create Authorization Code

```
POST /auth/keys/code
```

Create auth code for PKCE flow.

Request:
```typescript
{
  callback_url: string,          // HTTPS only, ports 443 or 3000
  code_challenge: string,        // PKCE challenge
  code_challenge_method: "S256" | "plain",
  limit?: number,                // Credit limit for new key
  expires_at?: string            // Key expiration
}
```

Response:
```typescript
{
  data: {
    id: string,                  // Auth code ID
    app_id: number,
    created_at: string
  }
}
```

### Exchange Code for API Key

```
POST /auth/keys/exchange
```

Exchange authorization code for API key.

Request:
```typescript
{
  code: string,                  // Auth code from callback
  code_verifier: string          // PKCE verifier
}
```

Response:
```typescript
{
  data: {
    key: string                  // New API key
  }
}
```

---

## OpenAPI Specification

Full specification available at:
- YAML: https://openrouter.ai/openapi.yaml
- JSON: https://openrouter.ai/openapi.json
