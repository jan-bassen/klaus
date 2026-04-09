# TODO v0.2.0 (ignore migration paths, we're able to fully reset still)

## Onboarding and UX Improvements for Auth Flow
- [ ] Auto-generate default settings.yml (and full internal folder structure) in vault on first startup
- [ ] Take QR out of the normal log flow
- [ ] Make getting chatID easier somehow?

## Improve Whatsapp UX 
- [ ] Add "me" mode (for people with no second number)
- [ ] Check if there are unused possiblities in baileys or smth I missed?

## Better error handling UX
- [ ] Check retry flow for potential improvements and consider a potential "undo" operation
- [ ] if feasible add /undo with a quoted message
- [ ] if feasible add /retry with a quoted failed message

## Agents
- [ ] Fitness - An agent that tracks my fitness goals/progress, manage my trainingplan and helps me stay on track. I want to call him directly with @fitness during training sessions and he should be able to provide me with motivation and insights, mostly through random (for me unexpected) dispatches to motivate me. Espescially on training days.
- [ ] Daily - An agent that runs every day in the morning to create a daily report in the daily note of the obsidian vault and a short voice message (in german). The daily report should include the weather, the most important few news (local, national, global), a quick check of one or two science news websites. 
- [ ] Nicola - Italian teacher
- [ ] Geo - Geography teacher/expert agent to learn and ask about geology (https://rapidapi.com/mmplabsadm/api/geography4)
- [ ] ??? - Life Coach (?)
- [ ] Ingest - As input handler from source to wiki/knowledge store à la [Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Documentation
- [ ] Update readme and check code comments etc
- [ ] Code cleanup (old code, repeated code, ...)
- [ ] Making everything human readible if possible
