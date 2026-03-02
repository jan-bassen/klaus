import type { InferSelectModel } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  nodes,
  edges,
  chunks,
  nodeVersions,
  tasks,
  messages,
  llmCosts,
  files,
} from './db/schema';
import type { ModelTier } from './config';

// -- DB row types --

export type Node = InferSelectModel<typeof nodes>;
export type Edge = InferSelectModel<typeof edges>;
export type Chunk = InferSelectModel<typeof chunks>;
export type NodeVersion = InferSelectModel<typeof nodeVersions>;
export type Task = InferSelectModel<typeof tasks>;
export type Message = InferSelectModel<typeof messages>;
export type LlmCost = InferSelectModel<typeof llmCosts>;
export type File = InferSelectModel<typeof files>;

// -- WhatsApp / transport --

export interface InboundMessage {
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

// -- Turn pipeline --

export interface TurnContext {
  msg: InboundMessage;
  agent: AgentDefinition;
  flags: Record<string, boolean>;
  assembled: AssembledContext;
}

export interface AssembledContext {
  conversation: string;
  graphContext: string;
  activeTasks: string;
  toolDescriptions: string;
  flagInjections: string;
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
  hooks?: AgentHookConfig[];
  /** Absolute path to the .md file — used for hot-reload */
  promptPath: string;
}

export interface AgentHookConfig {
  hook: string;
  signal: string;
}

export interface AgentReturn {
  hooks?: Record<string, HookSignal>;
}

export interface HookSignal {
  fire: boolean;
  hint?: string;
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
  run(turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult>;
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
