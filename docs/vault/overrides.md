# Overrides

An override tweaks a single turn without changing any agent file. You apply one inline with a `!preset` word, and the presets themselves are defined in `{vault}/Klaus/overrides.yml`. Overrides are for pipeline and agent *behaviour* (model tier, voice, history, ghosting), not for prompt content.

```text
!large !voice think through this plan with me
@meta !ghost inspect this without saving it to history
```

`!preset` words are parsed out anywhere after the route and merged on top of the agent's defaults. Any `!word` that does not match a known preset is left in the message text untouched, so a stray exclamation does no harm.

## Defining presets

Each entry in `overrides.yml` is registered under its name and every alias:

```yaml
large:
  description: Use the large model tier for this turn
  overrides:
    modelTier: large

voice:
  aliases: [v]
  description: Force a voice-note reply
  overrides:
    forceVoice: true

ghost:
  description: Leave no trace of this turn
  overrides:
    ghost: true
```

The shape of each entry is `{ aliases?, description, overrides }`. Presets are loaded at startup and again on hot-reload, so editing `overrides.yml` in Obsidian takes effect on the next turn.

## How overrides merge

Overrides are the last layer in the per-turn config build:

```
global defaults  →  agent frontmatter  →  !overrides
```

So an `!override` beats the agent's own frontmatter, which beats the global default. Two behaviours are special:

- The `vault` access map is deep-merged across all three layers, so an override cannot accidentally wipe out a grant the agent already had.
- `!voice` (`forceVoice`) always clears `suppressVoice`, so it wins even over an agent set to `voice: off`.

A handful of keys are override-only, because they only make sense for a single turn: `skipHistory`, `ghost`, and `toolChoice`. The full merge rules are in the [pipeline](../codebase/pipeline.md#overrides).

## Ghost mode

`!ghost` makes a turn ephemeral. The user message, the trace, and the assistant reply are all skipped, so the turn leaves no conversation record behind. It is handy for one-off inspections you do not want cluttering history.

## Overrides and voice notes

You cannot type a `@route` or `!override` into a voice note, so `/next` arms a prefix for the next message instead:

```text
/next @research !large
```

The next message, voice note included, is parsed as if it began with `@research !large`. See [usage](../usage.md#next-for-voice-notes).

---

**Related:** [agents](agents.md) · [settings](settings.md) · [usage](../usage.md) · [pipeline](../codebase/pipeline.md#overrides)
