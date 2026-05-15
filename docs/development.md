# Development

Code-level changes are for new primitives and runtime behavior. They are auto-discovered at startup, so add the file, export the right shape, test it, and restart the container.

Use explicit relative imports with `.ts` extensions. Keep the dependency list short. Prefer returning typed error values to throwing, except at true system boundaries.

## Add A Command

Commands bypass the LLM. Add a file under `src/primitives/commands/` and export a `Command`.

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

Test commands under `test/primitives/commands/`. Mock WhatsApp sends and assert the enqueued message, argument parsing, and error cases.

## Add A Variable

Variables become top-level Handlebars namespaces in prompts. Add a file under `src/primitives/variables/` and export a `Variable`.

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

## Add A Tool

Tools are model-callable functions. Add standalone tools to `src/primitives/tools/`, or grouped tools to a toolset under `src/primitives/tools/sets/`.

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
	sideEffect: "pure",
	kind: "builtin",
	capability: "tool",
};
```

Every tool declares `sideEffect`:

| Value | Meaning under `!simulate` |
| --- | --- |
| `pure` | Read-only. Calls the real tool. |
| `stateful` | Mutates local durable state. Uses `simulate` handler if present, otherwise records a fake success. |
| `external` | Touches the outside world. Does not call the real tool. Records a plausible fake. |

Use Zod schemas for inputs. Avoid `any` and type assertions. Return clear values the model can act on, including error objects or strings when user-correctable input is wrong.

## Add A Toolset

Toolsets are lazy-loaded groups of related tools. The agent sees a `load_<name>` meta-tool first. After it calls that, the real tools are injected for the next step.

Use a toolset when several tools belong together but are only useful on some turns, such as vault file operations, dispatch scheduling, or file-store helpers. Use standalone `tools: [...]` for tiny always-needed tools like `reply` or `react`.

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

After `load_text` runs, the tools in the set are called by their normal tool names, for example `shout`.

## Provider Tools

Provider tools are not local TypeScript tools. Agents declare them in frontmatter:

```yaml
providerTools: [web_search]
```

Klaus passes these through to the OpenRouter-compatible request. The provider executes them server-side, and the local tool loop does not see a client-side tool call.

## Tests

Tests live in `test/` mirroring `src/`.

Good targets:

- Commands: parsing, success response, invalid args, store/config updates.
- Variables: returned namespace shape and dependency behavior.
- Tools: schema validation assumptions, permission checks, success values, error values, simulation behavior.
- Pipeline changes: turn config, prompt rendering, report shape, store round-trips.

Use Vitest. For module isolation, the project config uses `pool: forks`. For settings overrides, mutate the live `settings` object in `beforeEach` and let `test/setup.ts` clean registries between tests.

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
