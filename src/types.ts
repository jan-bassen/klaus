import type { z } from "zod";
import type { ModelTier } from "./config";

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

export type DispatchMode =
	| { kind: "inline" }
	| { kind: "async" }
	| { kind: "cron"; schedule: string };

export interface DispatchOptions {
	agent: string;
	objective: string;
	hint?: string;
	mode: DispatchMode;
	chatId: string;
	caller?: string;
	parentTaskId?: string;
	/** Chain depth — incremented on each recursive dispatch. Enforces maxChainDepth. */
	depth?: number;
}

// -- Turn pipeline --

export interface TurnContext {
	chatId: string;
	/** Present for WhatsApp turns; undefined for dispatched agent invocations */
	message?: InboundMessage;
	/** Set for all dispatched agents (async and inline) */
	taskId?: string;
	agent: AgentDefinition;
	flags: Record<string, boolean>;
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
}

export interface AssembledContext {
	/** Context variables keyed by query name — directly available as {{variable}} in prompts */
	vars: Record<string, unknown>;
	totalTokens: number;
}

export interface TurnResult {
	success: boolean;
	error?: string;
}

// -- Agent system --

export interface AgentDefinition {
	name: string;
	modelTier: ModelTier;
	tools: string[];
	/** Toolset names — expanded to all `{name}.*` tools at runtime */
	toolsets?: string[];
	/** cron schedule string (e.g. "0 3 * * *") for scheduled agents */
	schedule?: string;
	/** Per-query params from the agent's YAML `context:` section, keyed by query name. */
	contextParams?: Record<string, Record<string, unknown>>;
	/** Anthropic provider tool names (e.g. "web_search", "web_fetch", "code_execution") */
	providerTools?: string[];
	/** Skill document names this agent can load on demand (filenames without .md in skills/) */
	skills?: string[];
	/** Optional vault subdirectory this agent is restricted to, e.g. "Training" */
	vaultScope?: string;
	/** Absolute path to the .md file — used for hot-reload */
	promptPath: string;
}

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

// -- Context queries --

export interface ContextQuery {
	name: string;
	/** Lower number = trimmed first on overflow */
	priority: number;
	run(
		turn: Omit<TurnContext, "assembled">,
		params?: Record<string, unknown>,
	): Promise<ContextResult>;
}

export interface ContextResult {
	/** Primary content for vars[query.name]. Omit for queries that only produce vars. */
	content?: string;
	tokenCount: number;
	truncate: "never" | "always" | "oldest";
	/** Named vars to inject beyond vars[query.name]. Token-free. */
	vars?: Record<string, unknown>;
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
	/** Dedup key: (task_id, ordinal) for task follow-ups or (message_id, ordinal) for direct replies */
	dedupKey: string;
	/** When set, the message is sent as a WhatsApp quote-reply to this message. */
	quoted?: { externalId: string; fromMe: boolean };
}
