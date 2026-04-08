import type { z } from "zod";
import type { AgentFrontmatterSchema } from "./core/agent";
import type { FlagOverrides } from "./core/flags";

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
	};
	/** Set by receive.ts when this message is a reply to another message */
	quotedMessage?: {
		/** Baileys stanzaId — used to find the quoted message */
		externalId: string;
		/** Text of the quoted message, extracted from Baileys contextInfo at receive time */
		text?: string;
		/** Resolved by pipeline.ts: image file linked to the quoted message, if any */
		media?: { fileId: string; path: string; mimeType: string };
	};
	timestamp: Date;
	/** Raw Baileys message key, used for reactions */
	messageKey: Record<string, unknown>;
}

// -- Dispatch --

export type DispatchMode = { kind: "inline" } | { kind: "async" };

export interface DispatchOptions {
	agent: string;
	objective: string;
	hint?: string;
	mode: DispatchMode;
	chatId: string;
	caller?: string;
	/** Chain depth — incremented on each recursive dispatch. Enforces maxChainDepth. */
	depth?: number;
}

// -- Turn pipeline --

export interface TurnContext {
	chatId: string;
	/** Present for WhatsApp turns; undefined for dispatched agent invocations */
	message?: InboundMessage;
	agent: AgentDefinition;
	flags: Record<string, boolean>;
	overrides: FlagOverrides;
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

// -- Agent system --

export type AgentDefinition = z.infer<typeof AgentFrontmatterSchema> & {
	/** Absolute path to the .md file — used for hot-reload */
	promptPath: string;
};

// -- Tool system --

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
	name: string;
	description: string;
	inputSchema: TInput;
	execute(input: z.infer<TInput>, context: TurnContext): Promise<unknown>;
	kind: "builtin" | "integration";
	capability: "tool" | "resource";
	requiresConfirmation?: boolean | undefined;
}

export interface ToolsetDefinition {
	/** Namespace prefix, e.g. "files". Tools are named "{name}.*". */
	name: string;
	/** One-line description of when to activate this toolset. */
	description: string;
	/** All tools belonging to this toolset. */
	tools: ToolDefinition<z.ZodTypeAny>[];
}

// -- Context variables --

export interface ContextVariable {
	name: string;
	/** Short description for /help output */
	description?: string;
	/** Named parameters this variable accepts, e.g. { limit: "max items" } */
	params?: Record<string, string>;
	/** Lower number = trimmed first on overflow */
	priority: number;
	run(
		turn: Omit<TurnContext, "assembled">,
		params?: Record<string, string>,
	): Promise<ContextVariableResult>;
}

export interface ContextVariableResult {
	/** Primary content for vars[query.name]. Omit for queries that only produce vars. */
	content?: string;
	tokenCount: number;
	truncate: "never" | "always" | "oldest";
	/** Named vars to inject beyond vars[query.name]. Token-free. */
	vars?: Record<string, unknown>;
	/** Vars available only in user message $var interpolation. Token-free. */
	userVars?: Record<string, unknown>;
}

// -- Evals --

export interface Eval {
	name: string;
	input: string;
	context?: Partial<TurnContext>;
	assertions: EvalAssertion[];
}

export interface EvalAssertion {
	type: "tool_called" | "tool_not_called" | "output_matches" | "llm_judge";
	value: string;
}

// -- Send queue --

export type MessageOrdinal = number;

export interface OutboundMessage {
	chatId: string;
	content: string | Buffer;
	mimeType?: string;
	/** Dedup key: (message_id, ordinal) for deduplicating outbound messages */
	dedupKey: string;
	/** When set, the message is sent as a WhatsApp quote-reply to this message. */
	quoted?: { externalId: string; fromMe: boolean };
}
