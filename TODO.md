# TODO

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher

# Later

## Internationalization (only when simple)
- [ ] Add support for multiple languages for all user-facing (and probably even agent-facing) strings

## Evals
- [ ] Add `*.eval.ts` files for non-deterministic behavior (pipeline end-to-end, agent tool selection, memory search relevance)
- [ ] See `AGENT.md` for eval conventions

I just simplified the memory system drastically. It is now colocated in my vault instead of a postgres. I genuenly like that change as the whole project is build under the goal of maximum simplicity. Now, I do wonder if the memory is a bit too limited now. I have snippets that are always fully loaded when included in the prompt, and I have skills which are dynamically loaded instructions. But I feel like one primitive is missing: Auto-managed and on-demand things (less important instructions, personality adaptations that go beyond the snippet, ...). What do you think could we add to fix this gap?
