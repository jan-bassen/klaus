import type { AgentDefinition } from "./agent";
import type { DispatchMode } from "./agent/dispatch";
import type { overrides } from "./pipeline/overrides";

// Re-export domain types for convenience — consumers should prefer importing from the domain directly
export type { AgentDefinition } from "./agent";
export type { DispatchMode, DispatchOptions } from "./agent/dispatch";
export type { ContextVariable, ContextVariableResult } from "./context";
export type { ToolDefinition, ToolsetDefinition } from "./tools";
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
		/** Baileys stanzaId — used to find the quoted message */
		externalId: string;
		/** Text of the quoted message, extracted from Baileys contextInfo at receive time */
		text?: string;
		/** Resolved by pipeline.ts: file linked to the quoted message, if any */
		media?: { fileId: string; path: string; mimeType: string };
	};
	timestamp: Date;
	/** Raw Baileys message key, used for reactions */
	messageKey: Record<string, unknown>;
}

// -- Turn pipeline --

export interface TurnContext {
	chatId: string;
	/** Present for WhatsApp turns; undefined for dispatched agent invocations */
	message?: InboundMessage;
	agent: AgentDefinition;
	activeoverrides: Record<string, boolean>;
	overrides: overrides;
	/** Flat vars available in all Handlebars templates (agent prompts, snippets). */
	templateVars: Record<string, unknown>;
	assembled: AssembledContext;
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

export interface AssembledContext {
	/** Context variables keyed by query name — directly available as {{variable}} in prompts */
	vars: Record<string, unknown>;
	/** Vars available only in user message $var interpolation */
	userVars: Record<string, unknown>;
	/** Label → externalId mapping for message references (reply/react tools) */
	messageRefs: Record<string, { externalId: string; role: string }>;
	totalTokens: number;
}

export interface TurnResult {
	success: boolean;
	error?: string;
}
