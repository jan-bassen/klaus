import { z } from "zod";
import type { TurnContext } from "../../pipeline/core.ts";
import type { ToolDefinition } from "./index.ts";

export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const RETURN_RESULT_TOOL_NAME = "return_result";
export const SET_REACTION_TOOL_NAME = "set_reaction";
export const SEND_IMAGE_TOOL_NAME = "send_image";
export const END_TURN_TOOL_NAME = "end_turn";

export const CORE_TOOL_NAMES = new Set([
	SEND_MESSAGE_TOOL_NAME,
	RETURN_RESULT_TOOL_NAME,
	SET_REACTION_TOOL_NAME,
	SEND_IMAGE_TOOL_NAME,
	END_TURN_TOOL_NAME,
]);

export function resolveCoreToolNames(
	turn: Pick<TurnContext, "trigger">,
): string[] {
	if (turn.trigger.kind === "dispatch")
		return [RETURN_RESULT_TOOL_NAME, END_TURN_TOOL_NAME];
	if (turn.trigger.kind === "message") {
		return [
			SEND_MESSAGE_TOOL_NAME,
			SET_REACTION_TOOL_NAME,
			SEND_IMAGE_TOOL_NAME,
			END_TURN_TOOL_NAME,
		];
	}
	return [SEND_MESSAGE_TOOL_NAME, SEND_IMAGE_TOOL_NAME, END_TURN_TOOL_NAME];
}

const returnResultSchema = z.object({
	text: z
		.string({ error: "Return the complete result text in text." })
		.min(1, { error: "Return the complete result text in text." })
		.refine((value) => value.trim().length > 0, "Result content is required")
		.describe("Complete result text to return to the calling agent."),
});

export const returnResultTool: ToolDefinition<typeof returnResultSchema> = {
	name: RETURN_RESULT_TOOL_NAME,
	description: "Return the completed result to the invoking agent.",
	inputSchema: returnResultSchema,
	execute: async ({ text }, context) => {
		if (context.trigger.kind !== "dispatch") {
			return { error: "return_result only works during inline dispatch" };
		}
		if (!context._resultCollector) {
			return { error: "No inline result collector is available" };
		}
		context._resultCollector.push(text);
		return "returned";
	},
};

const endTurnSchema = z.object({});

export const endTurnTool: ToolDefinition<typeof endTurnSchema> = {
	name: END_TURN_TOOL_NAME,
	description:
		"End this agent turn when the current user request is complete and no more tool work or user-visible messages are needed.",
	inputSchema: endTurnSchema,
	execute: async () => "Turn ended.",
};
