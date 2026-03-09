import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  real,
  numeric,
  timestamp,
  jsonb,
  customType,
  vector,
  index,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// -- custom types --

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

// -- enums --

export const nodeType = pgEnum('node_type', [
  'episode',
  'procedure',
  'topic',
  'document',
  'project',
  'entity',
  'assertion',
]);

export const edgeRelationType = pgEnum('edge_relation_type', [
  'about',
  'part_of',
  'derived_from',
  'influenced_by',
  'references',
  'supersedes',
  'related_to',
]);

export const provenanceSourceType = pgEnum('provenance_source_type', [
  'message',
  'task',
  'external',
]);

export const nodeVersionReasonType = pgEnum('node_version_reason', [
  'user_edit',
  'contradiction_resolved',
  'merged',
  'reflection',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

// -- tables --

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: nodeType('type').notNull(),
  title: text('title'),
  body: text('body'),
  tags: text('tags').array().default(sql`'{}'::text[]`),
  pinned: boolean('pinned').default(false).notNull(),
  archived: boolean('archived').default(false).notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),
  searchTsv: tsvector('search_tsv'),
  tokenCount: integer('token_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const edges = pgTable('edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  relation: edgeRelationType('relation').notNull(),
  weight: real('weight').default(1.0),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique().on(t.sourceId, t.targetId, t.relation),
  index('idx_edges_source').on(t.sourceId),
  index('idx_edges_target').on(t.targetId),
  index('idx_edges_relation').on(t.relation),
]);

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1024 }),
  searchTsv: tsvector('search_tsv'),
  tokenCount: integer('token_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const nodeVersions = pgTable('node_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title'),
  body: text('body'),
  tags: text('tags').array(),
  reason: nodeVersionReasonType('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_node_versions_node').on(t.nodeId),
  unique().on(t.nodeId, t.version),
]);

export const provenance = pgTable('provenance', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  sourceType: provenanceSourceType('source_type').notNull(),
  sourceId: uuid('source_id'),
  sourceRef: text('source_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_provenance_node').on(t.nodeId),
  index('idx_provenance_source').on(t.sourceType, t.sourceId),
]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  role: text('role').notNull(),
  content: text('content'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** Baileys message ID — stored so quoted-message FK resolution can look up our DB UUID */
  externalId: text('external_id'),
  /** Self-referential FK to the quoted message row (null when not a reply or message not in DB) */
  quotedMessageId: uuid('quoted_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
}, (t) => [
  index('idx_messages_chat_time').on(t.chatId, t.createdAt),
  index('idx_messages_external').on(t.chatId, t.externalId),
]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  objective: text('objective').notNull(),
  assignedTo: text('assigned_to'),
  caller: text('caller'),
  status: taskStatusEnum('status').notNull(),
  result: jsonb('result'),
  parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('idx_tasks_chat').on(t.chatId),
]);


export const llmBudgets = pgTable('llm_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: text('chat_id').notNull(),
  dailyLimitUsd: numeric('daily_limit_usd', { precision: 10, scale: 2 }),
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 10, scale: 2 }),
  currentDailyUsd: numeric('current_daily_usd', { precision: 10, scale: 6 }).default('0'),
  currentMonthlyUsd: numeric('current_monthly_usd', { precision: 10, scale: 6 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('uq_llm_budgets_chat').on(t.chatId),
]);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentInvocations = pgTable('agent_invocations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  messageId:        uuid('message_id').references(() => messages.id),
  taskId:           uuid('task_id').references(() => tasks.id),
  agent:            text('agent').notNull(),
  model:            text('model').notNull(),
  systemPrompt:     text('system_prompt'),
  userMessage:      text('user_message'),
  steps:            jsonb('steps').notNull().default(sql`'[]'::jsonb`),
  promptTokens:     integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  costUsd:          numeric('cost_usd', { precision: 10, scale: 6 }),
  durationMs:       integer('duration_ms'),
  createdAt:        timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_agent_invocations_message').on(t.messageId),
]);
