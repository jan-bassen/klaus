import type { InferSelectModel } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  nodes,
  edges,
  chunks,
  nodeVersions,
  tasks,
  messages,
  files,
  agentInvocations,
} from './db/schema';
import type { ModelTier } from './config';

// -- DB row types --

export type Node = InferSelectModel<typeof nodes>;
export type Edge = InferSelectModel<typeof edges>;
export type Chunk = InferSelectModel<typeof chunks>;
export type NodeVersion = InferSelectModel<typeof nodeVersions>;
export type Task = InferSelectModel<typeof tasks>;
export type Message = InferSelectModel<typeof messages>;
export type File = InferSelectModel<typeof files>;
export type AgentInvocation = InferSelectModel<typeof agentInvocations>;

// -- WhatsApp / transport --

export interface InboundMessage {
  kind: 'whatsapp';
  id: string;
  chatId: string;
  senderId: string;
  text?: string;
  /** Set by receive.ts after blob is persisted to the files volume */
  media?: { fileId: string; path: string; mimeType: string; transcription?: string };
  timestamp: Date;
  /** Raw Baileys message key, used for reactions */
  messageKey: Record<string, unknown>;
}

// -- Dispatch --

export type DispatchMode =
  | { kind: 'inline' }
  | { kind: 'async' }
  | { kind: 'cron'; schedule: string };

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
  /** DB ID of the persisted inbound message row — set in pipeline after insert */
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
  vars: Record<string, string>;
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
  /** Absolute path to the .md file — used for hot-reload */
  promptPath: string;
}

// -- Tool system --

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: (input: z.infer<TInput>, context: TurnContext) => Promise<unknown>;
  kind: 'builtin' | 'integration';
  capability: 'tool' | 'resource';
  /** Promoted to always-available even when its toolset is not loaded */
  surface?: boolean;
  requiresConfirmation?: boolean;
}

// -- Context queries --

export interface ContextQuery {
  name: string;
  /** Lower number = trimmed first on overflow */
  priority: number;
  run(turn: Omit<TurnContext, 'assembled'>, params?: Record<string, unknown>): Promise<ContextResult>;
}

export interface ContextResult {
  content: string;
  tokenCount: number;
  truncate: 'never' | 'always' | 'oldest' | 'summarize';
}

// -- Evals --

export interface Eval {
  name: string;
  input: string;
  context?: Partial<TurnContext>;
  assertions: EvalAssertion[];
}

export interface EvalAssertion {
  type: 'tool_called' | 'tool_not_called' | 'output_matches' | 'llm_judge';
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
}
