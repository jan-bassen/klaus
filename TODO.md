# TODO

## Unify Memory Layer
- [ ] 

## Cleanup
- [ ] rename docker volumes to data, files, vault, and config (with baileys auth and obsidian sync config)
- [ ] rename sync container to obsidian
- [ ] Make logs in console pretty, store structured still

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

I just simplified the memory system drastically. It is now colocated in my vault instead of a postgres. I genuenly like that change as the whole project is build under the goal of maximum simplicity. Now, I do wonder if the memory is a bit too limited now. Most important things for the context sit directly in instructions and prompts, as they are easy to change, but I also always liked the idea that Klaus can build his own personality a bit (self-improvement, character development) and be more personalized by remembering our past interactions while not having all the valuable context be gobbled up by it. Can you explore our options for a somewhat more sophisticated auto-adjustment/memory system? Something that fits nicely in here?
Don't plan any implementation yet! I want one or a few good conceptual ideas (what's the primitive long-term memory in this context) first, before diving into details!
