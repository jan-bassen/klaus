import type { AgentDefinition } from "./agent";
import type { DispatchMode } from "./agent/dispatch";
import type { TurnConfig } from "./pipeline/overrides";

// Re-export domain types for convenience — consumers should prefer importing from the domain directly
export type { AgentDefinition } from "./agent";
export type { DispatchMode, DispatchOptions } from "./agent/dispatch";
export type { ToolDefinition, ToolsetDefinition } from "./tools";
export type { Variable } from "./variables";
export type { MessageOrdinal, OutboundMessage } from "./whatsapp/send";

// -- WhatsApp / transport --

export interface InboundMessage {
	kind: "whatsapp";
	id: string;
	chatId: string;
	senderId: string;
	text?: string;
	/** Set by receive.ts after blob is persisted to the files volume */
	media?: {
		fileId: string;
		path: string;
		mimeType: string;
		transcription?: string;
		/** For voice notes: the original typed caption before transcript replaced text */
		voiceCaption?: string;
		/** For documents: the original filename from Baileys */
		fileName?: string;
		/** For documents: text extracted by the parser (populated in pipeline normalize) */
		extractedText?: string;
	};
	/** Set by receive.ts when this message is a reply to another message */
	quotedMessage?: {
		externalId: string;
		text?: string;
		media?: { fileId: string; path: string; mimeType: string };
	};
	timestamp: Date;
	messageKey: Record<string, unknown>;
}

// -- Turn pipeline --

export interface TurnContext {
	chatId: string;
	/** Present for WhatsApp turns; undefined for dispatched agent invocations */
	message?: InboundMessage;
	agent: AgentDefinition;
	/** Names of override presets activated this turn (e.g. ["voice","large"]). */
	overrides: Record<string, boolean>;
	/** Effective turn configuration — agent defaults merged with per-message overrides. */
	config: TurnConfig;
	/** Unified nested variable namespace (e.g. vars.media.doc.text, vars.time.date). */
	vars: Record<string, unknown>;
	/** Label → externalId mapping for message references (reply/react tools). */
	messageRefs: Record<string, { externalId: string; role: string }>;
	/** Internal message ID — set in pipeline after insert */
	messageId?: string;
	/** Injected for dispatched agents; undefined for direct @agent WhatsApp calls */
	dispatchContext?: {
		caller: string;
		objective: string;
		hint?: string;
		mode: DispatchMode;
	};
	/** @internal — collects reply content for inline-dispatched agents instead of sending to WhatsApp */
	_replyCollector?: string[];
}

export interface TurnResult {
	success: boolean;
	error?: string;
}
