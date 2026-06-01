# Usage

How you talk to Klaus over WhatsApp. Everything here happens in the one chat Klaus listens to (see [setup.md](setup.md) for choosing that chat).

Every inbound message is parsed in the same order: voice is transcribed and documents are extracted to text, then an armed `/next` prefix is prepended, then a leading `/command` is detected, then a leading `@agent` route is pulled off, then `!overrides` are stripped out. What remains is the message the agent sees.

## Routing to an agent

An unprefixed message goes to the chat's default agent:

```text
what changed in my project notes?
```

Route to a specific agent with `@name` or an alias:

```text
@meta always reply in Italian from now on
@m move the daily brief to 7am
@research compare these sources with my project notes
```

Aliases are defined per agent (`@m` → `meta`, `@r` → `research`, `@d` → `dispatch`). The bundled agents are described in [agents.md](agents.md). Change the default agent for the chat with `/default`.

## Commands

A message starting with `/` is a command. It bypasses the model entirely — the handler runs and the turn ends, so commands never cost a model call. Unknown commands are silently ignored. Most commands act on the chat's **default agent**.

| Command | Aliases | Argument | Effect |
| --- | --- | --- | --- |
| `/help` | `/?` | `[section]` | Show help. Optional section: `settings`, `agents`, `commands`, `overrides`. |
| `/default` | `/d` | `<agent>` | Set the chat's default agent (loads the file if needed). |
| `/model` | `/m` | `[small\|medium\|large]` | No arg shows the current model; an arg writes `modelTier` to the default agent's frontmatter. |
| `/provider` | `/p` | `[provider]` | No arg shows the current provider; an arg writes `provider` to the default agent's frontmatter. |
| `/voice` | `/v` | `[on\|off\|auto]` | No arg shows the setting; an arg writes `voice` to the default agent's frontmatter. |
| `/image` | `/img` | `<prompt>` | Generate an image (uses a quoted image as source if present). |
| `/next` | `/n` | `<prefix>` \| `cancel` | Arm a single-use routing/override prefix for the next non-command message. |
| `/schedules` | `/s` | — | List active schedules and timers (read-only). |
| `/retry` | `/r` | — | Re-run the most recent failed turn with its original route and overrides. |
| `/break` | `/b` | — | Insert a context boundary; history before it is dropped from future turns. |
| `/stop` | `/kill` | — | Panic stop: abort active runs and pause all schedules and timers. |
| `/resume` | — | — | Re-arm schedules and timers after `/stop`. |

`/model`, `/provider`, and `/voice` write to the agent's `.md` frontmatter in the vault, so changes persist and hot-reload. `/stop` does not delete any persisted schedule or timer — it only pauses them; `/resume` brings them back once setup is complete and WhatsApp is connected.

## Overrides

`!preset` words tweak a single turn. They are parsed out anywhere after the route and merged on top of the agent's defaults. Presets are defined in `{vault}/Klaus/overrides.yml` (see [pipeline.md](pipeline.md#overrides) for the merge rules and [primitives.md](primitives.md) for what they can set).

```text
!large !voice think through this plan with me
@meta !ghost inspect this without saving it to history
```

Overrides are for pipeline and agent *behaviour* (model tier, voice, history, ghosting) — not prompt content. Unrecognised `!words` are left in the message text untouched.

## /next for voice notes

You cannot type a `@route` or `!override` into a voice note, so `/next` arms a prefix for the next non-command message:

```text
/next @research !large
```

The next message — including a voice note — is parsed as if it began with `@research !large`, then the prefix is consumed. `/next cancel` clears it; `/next` with no argument shows what is armed.

## Media

- **Voice notes** are transcribed to text; the transcript becomes the message and the original is kept as a caption.
- **Images and stickers** become vision input for the turn.
- **Documents** (PDF, Office formats) are parsed to text, cached next to the file, and truncated to a configured length.
- **Quoted messages** can carry their original media into the turn.

Reports redact image data URLs but keep a readable media marker and the stored filename. See [pipeline.md](pipeline.md#reports).

## How agents reply

Agents reply by calling the `send_message` tool, not by emitting plain text. The tool takes the final `text`, can mark that same text for voice delivery with `asVoiceNote`, and can quote an older message with a positive `quoteMessageLabel` taken from the visible `ref #n` history markers. Normal replies omit the quote label.

A turn may also just react (`set_reaction`) without sending a message; that stays valid and is recorded. If a turn that *should* have sent a message ends with plain assistant text instead, Klaus sends that text as a fallback message and flags the formatting miss in the run report.

---
---
---
---
---
## [Continue to Agents](agents.md)
