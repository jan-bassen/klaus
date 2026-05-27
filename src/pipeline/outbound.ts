import { log } from "../infra/logger.ts";
import { appendAck, appendMessage } from "../infra/store/history.ts";
import type { TurnContext } from "./core.ts";

interface OutboundQuote {
	externalId: string;
	fromMe: boolean;
}

interface PreparedOutbound {
	quoted?: OutboundQuote;
	onSent?: (waId: string) => void;
	dedupKey: string;
}

type MessageRef = number;

export async function prepareAssistantOutbound(input: {
	context: TurnContext;
	content: string;
	kind: string;
	logPrefix: string;
	voice?: boolean | undefined;
	messageRef?: MessageRef | undefined;
}): Promise<PreparedOutbound | { error: string }> {
	const quoted = resolveMessageRef(input.context, input.messageRef);
	if (quoted instanceof Error) return { error: quoted.message };

	const rowId = await persistAssistantMessage(
		input.context,
		input.content,
		input.logPrefix,
		input.voice ?? false,
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
	messageRef: MessageRef | undefined,
): OutboundQuote | undefined | Error {
	if (messageRef === undefined) return undefined;

	if (messageRef === 0) {
		if (!context.message) {
			return new Error("No current message to quote");
		}
		return { externalId: context.message.id, fromMe: false };
	}

	const label = String(messageRef);
	const ref = context.messageRefs?.[label];
	if (!ref) return new Error(`Unknown message label: #${messageRef}`);
	return { externalId: ref.externalId, fromMe: ref.role !== "user" };
}

async function persistAssistantMessage(
	context: TurnContext,
	content: string,
	logPrefix: string,
	voice: boolean,
): Promise<string | undefined> {
	if (context.config?.ghost) return undefined;
	if (!content.trim()) return undefined;

	try {
		return await appendMessage({
			role: "assistant",
			content,
			agent: context.agent.name,
			runId: context.runId,
			...(voice ? { voice: true } : {}),
		});
	} catch (err) {
		log.warn(`${logPrefix} failed to persist assistant message`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}
