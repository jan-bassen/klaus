# Tool Calling (Function Calling)

## Overview

Tool calling allows models to request execution of functions you define. The process involves:
1. Define tools and send initial request
2. Model returns tool calls with arguments
3. Execute tools locally and return results
4. Model generates final response

## Tool Definition

```typescript
{
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City name, e.g., 'San Francisco, CA'"
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Temperature unit"
          }
        },
        required: ["location"]
      },
      strict: true  // Enable strict schema validation (optional)
    }
  }]
}
```

## Tool Choice Options

```typescript
{
  tool_choice: "auto",      // Model decides (default)
  tool_choice: "none",      // Disable tool calling
  tool_choice: "required",  // Force at least one tool call
  tool_choice: {            // Force specific tool
    type: "function",
    function: { name: "get_weather" }
  },

  parallel_tool_calls: true  // Allow multiple simultaneous calls (default)
}
```

## Complete Example

### Step 1: Initial Request

```typescript
const tools = [{
  type: "function",
  function: {
    name: "search_products",
    description: "Search for products in the catalog",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        category: { type: "string", enum: ["electronics", "clothing", "books"] },
        max_price: { type: "number", description: "Maximum price in USD" }
      },
      required: ["query"]
    }
  }
}];

const response1 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openai/gpt-5.2",
    messages: [
      { role: "user", content: "Find me a laptop under $1000" }
    ],
    tools
  })
});

const data1 = await response1.json();
```

### Step 2: Check for Tool Calls

```typescript
const message = data1.choices[0].message;

if (message.tool_calls) {
  // Model wants to call tools
  const toolResults = [];

  for (const toolCall of message.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments);

    // Execute your function
    let result;
    if (toolCall.function.name === "search_products") {
      result = await searchProducts(args.query, args.category, args.max_price);
    }

    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result)
    });
  }
}
```

### Step 3: Send Results Back

```typescript
const response2 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openai/gpt-5.2",
    messages: [
      { role: "user", content: "Find me a laptop under $1000" },
      message,        // Include the assistant's tool_calls message
      ...toolResults  // Include all tool results
    ],
    tools  // Include tools in every request
  })
});

const data2 = await response2.json();
console.log(data2.choices[0].message.content);
```

## Agentic Loop Pattern

For multi-step tool use:

```typescript
async function agentLoop(userMessage, maxIterations = 10) {
  const messages = [{ role: "user", content: userMessage }];

  for (let i = 0; i < maxIterations; i++) {
    const response = await callOpenRouter(messages, tools);
    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls) {
      // No more tool calls, return final response
      return assistantMessage.content;
    }

    // Execute tool calls
    for (const toolCall of assistantMessage.tool_calls) {
      const result = await executeFunction(
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments)
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  throw new Error("Max iterations reached");
}
```

## Streaming with Tool Calls

Tool calls stream as deltas:

```typescript
const stream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openai/gpt-5.2",
    messages: [...],
    tools,
    stream: true
  })
});

// Accumulate tool call deltas
let toolCalls = {};

for await (const chunk of parseSSE(stream)) {
  const delta = chunk.choices[0].delta;

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (!toolCalls[tc.index]) {
        toolCalls[tc.index] = { id: tc.id, function: { name: "", arguments: "" } };
      }
      if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
    }
  }
}
```

## Interleaved Thinking

Some models support reasoning between tool calls. Enable with Anthropic beta header:

```typescript
headers: {
  "x-anthropic-beta": "interleaved-thinking-2025-05-14"
}
```

The model can reason about tool results before deciding next steps.

## Models with Strong Tool Support

For optimal tool-calling accuracy, consider:
- OpenAI GPT-5.x models
- Anthropic Claude 4.x models
- Google Gemini 3 models
- Models with `:exacto` suffix (curated for tool accuracy)

Use `:exacto` suffix for higher tool-calling accuracy:
```typescript
model: "moonshotai/kimi-k2-0905:exacto"
```

## Best Practices

1. **Clear descriptions**: Write detailed function and parameter descriptions
2. **Strict schemas**: Use `strict: true` for JSON schema validation
3. **Error handling**: Return meaningful error messages in tool results
4. **Timeout handling**: Implement timeouts for tool execution
5. **Result format**: Keep tool results concise and structured
6. **Idempotency**: Design tools to be safely re-callable
