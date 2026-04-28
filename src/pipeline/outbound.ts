import { log } from "@/infra/logger";
import { appendAck, appendMessage } from "@/infra/store/history";
import type { TurnContext } from "@/pipeline/core";

interface OutboundQuote {
	externalId: string;
	fromMe: boolean;
}

interface PreparedOutbound {
	quoted?: OutboundQuote;
	onSent?: (waId: string) => void;
	dedupKey: string;
}

export async function prepareAssistantOutbound(input: {
	context: TurnContext;
	content: string;
	kind: string;
	logPrefix: string;
	messageRef?: string | undefined;
}): Promise<PreparedOutbound | { error: string }> {
	const quoted = resolveMessageRef(input.context, input.messageRef);
	if (quoted instanceof Error) return { error: quoted.message };

	const rowId = await persistAssistantMessage(
		input.context,
		input.content,
		input.logPrefix,
	);

	const onSent = rowId
		? (waId: string) => {
				appendAck(rowId, waId).catch((err: unknown) => {
					log.warn(`${input.logPrefix} failed to backfill externalId`, {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		: undefined;

	return {
		dedupKey: makeDedupKey(input.context, input.kind),
		...(quoted ? { quoted } : {}),
		...(onSent ? { onSent } : {}),
	};
}

export function makeDedupKey(context: TurnContext, kind: string): string {
	return context.message
		? `${context.message.id}:${kind}:${crypto.randomUUID()}`
		: `${context.chatId}:${kind}:${crypto.randomUUID()}`;
}

function resolveMessageRef(
	context: TurnContext,
	messageRef: string | undefined,
): OutboundQuote | undefined | Error {
	if (!messageRef) return undefined;

	let ref: { externalId: string; role: string } | undefined;
	if (messageRef === "current") {
		if (!context.message) {
			return new Error(
				'messageRef "current" requires an inbound message context',
			);
		}
		ref = { externalId: context.message.id, role: "user" };
	} else {
		ref = context.messageRefs?.[messageRef];
	}

	if (!ref) return new Error(`Unknown message reference: #${messageRef}`);
	return { externalId: ref.externalId, fromMe: ref.role !== "user" };
}

async function persistAssistantMessage(
	context: TurnContext,
	content: string,
	logPrefix: string,
): Promise<string | undefined> {
	if (context.config?.ghost) return undefined;

	try {
		return await appendMessage({
			role: "assistant",
			content,
			agent: context.agent.name,
			runId: context.runId,
		});
	} catch (err) {
		log.warn(`${logPrefix} failed to persist assistant message`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}
