# Primitives

Primitives are the pluggable extension surface under `src/primitives/`. Add a file, export the expected shape, test it, and restart the container.

## Commands

Commands live in `src/primitives/commands/`. They start with `/`, bypass the LLM, and are for deterministic runtime actions.

`/stop` is the panic button: it aborts active agent runs through the shared run registry and pauses schedule/timer clocks without deleting their persisted state. Its alias is `/kill`. `/resume` re-arms future work after a panic stop.

```ts
import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

export const pingCommand: Command = {
	name: "ping",
	description: "Check that Klaus can reply",
	execute(msg: InboundMessage): Promise<void> {
		enqueueMessage({
			chatId: msg.chatId,
			content: "pong",
			dedupKey: `${msg.id}:ping`,
			label: settings.whatsapp.systemLabel,
		});
		return Promise.resolve();
	},
};
```

Test commands under `test/primitives/commands/`. Mock WhatsApp sends and cover argument parsing, success, and user-facing errors.

## Variables

Variables live in `src/primitives/variables/` and become top-level Handlebars namespaces.

```ts
import type { Variable } from "./index.ts";

export const projectVariable: Variable = {
	key: "project",
	description: "Current project context",
	async run() {
		return {
			name: "Klaus",
			status: "development",
		};
	},
};
```

Agents can then use:

```handlebars
{{project.name}} is currently {{project.status}}.
```

If a variable depends on earlier variables, set `after: true` and read `turn.vars`. Use that sparingly.

## Tools

Tools are model-callable functions. Add standalone tools to `src/primitives/tools/`, or grouped tools to `src/primitives/tools/sets/`.

```ts
import { z } from "zod";
import type { ToolDefinition } from "./index.ts";

const schema = z.object({
	text: z.string(),
});

export const shoutTool: ToolDefinition<typeof schema> = {
	name: "shout",
	description: "Uppercase a short text string.",
	inputSchema: schema,
	async execute({ text }) {
		return text.toUpperCase();
	},
};
```

Use Zod schemas for inputs. Klaus validates every model-supplied tool call against the schema before `execute` runs; invalid calls return an error result to the model and do not perform side effects. Put corrective `error` messages on constraints the model commonly gets wrong (for example integer message refs, nonnegative counts, nonempty required text), so the returned validation error tells the agent how to retry. Avoid `any` and type assertions. Return clear values the model can act on, including error objects or strings when runtime conditions are wrong.

`reply` is the terminal user-visible output tool. It requires complete nonblank
message content; `voice` is a delivery flag for that same content, not a
separate action. Message references are numeric: `0` means the current message,
and positive integers refer to numbered history entries. Omit `messageRef` for
normal replies to the current message; use it only when an explicit quote target
matters.

## Toolsets

Toolsets are lazy groups. The agent first sees a `load_<name>` meta-tool; after it calls the loader, the actual tools are injected on the next model step.

```ts
import type { ToolsetDefinition } from "../index.ts";
import { shoutTool } from "../shout.ts";

export const textToolset: ToolsetDefinition = {
	name: "text",
	description: "Text transformation utilities.",
	tools: [shoutTool],
};
```

Reference a toolset from agent frontmatter:

```yaml
toolsets: [text]
```

Use toolsets for clusters like vault operations, dispatch scheduling, or file-store helpers. Use always-visible `tools` for tiny core tools like `reply` and `react`. The scoped `skill_get` tool is generated automatically for agents that declare `skills`.

## Provider Tools

Provider tools are not local TypeScript tools. Agents declare them in frontmatter:

```yaml
providerTools: [web_search, web_fetch]
```

Klaus passes these through to the OpenRouter-compatible request. The provider executes them server-side, and the local tool loop does not see a client-side tool call.

## Restart Boundary

Hot-reloaded:

- Agents
- Skills
- Snippets
- Templates
- `overrides.yml`
- `settings.yml`

Requires restart:

- Commands
- Variables
- Tools
- Toolsets
- Store behavior
- Pipeline behavior
- Infra behavior

For vault-side configuration of commands, tools, variables, and overrides, see [../vault/settings.md](../vault/settings.md).
