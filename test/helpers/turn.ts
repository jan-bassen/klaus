/**
 * Build a minimal valid `TurnContext` for tests that poke pipeline internals
 * without going through `handleTurn`. Override any field via `patch`.
 */

import type { AgentDefinition } from "../../src/pipeline/agents.ts";
import type { TurnContext } from "../../src/pipeline/core.ts";
import type { TurnConfig } from "../../src/pipeline/overrides.ts";

export function makeTurn(patch: Partial<TurnContext> = {}): TurnContext {
	const agent: AgentDefinition =
		(patch.agent as AgentDefinition) ??
		({
			name: "test",
			aliases: [],
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			settings: {
				voice: "auto",
				accept: false,
				temp: "default",
				topP: "default",
				reasoningEffort: "default",
				showTrace: true,
				report: "agent",
			},
			promptPath: "/tmp/nonexistent.md",
		} as unknown as AgentDefinition);

	const config: TurnConfig = (patch.config as TurnConfig) ?? {};

	return {
		chatId: "c1",
		runId: "r-test",
		trigger: { kind: "message", messageId: "m-test" },
		overrides: {},
		config,
		vars: {},
		messageRefs: {},
		pendingSubReplies: [],
		agent,
		...patch,
	};
}
