{{#if (eq kind "timeout")}}The AI model timed out — please try again.
{{else if (eq kind "rate_limit")}}Too many requests right now — please try again in a moment.
{{else if (eq kind "too_long")}}Your conversation got too long for the model — try starting fresh.
{{else}}Something went wrong: {{message}}
{{/if}}
