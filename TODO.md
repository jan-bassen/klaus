# TODO

## Fixes
- [ ] Task sync responses should go back to calling agent, not directly to user (I tested and I got one message from the subagent and then from the main one too)
- [ ] Conversation history can't be in system prompt (ai sdk has it's own messages, see https://ai-sdk.dev/docs/foundations/prompts#message-prompts). Quote should then go directly in the message itself (plus media i think is already auto-loaded)
- [ ] Then we can also remove params from the context queries (we used to have pg in the stack). Conversation limit should be in the agent frontmatter
- [ ] Check Voice message skip. A voice message I sent was ignored for some reason (logs: 12:29:29.690 DBG [receive] skip no content  remoteJid=36911083159745@lid 12:29:29.690 WRN [receive] media download failed — continuing as text-only  remoteJid=36911083159745@lid error "error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT")

## Exploration
- [ ] Can we preserve thought processes between runs somehow and should we?

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

# Later

## GitHub action ci/cd for image building (?)

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions
