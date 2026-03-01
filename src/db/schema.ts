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
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// -- custom types --

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const vector = (name: string, config: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${config.dimensions})`,
    toDriver: (value: number[]) => `[${value.join(',')}]`,
    fromDriver: (value: string) => value.slice(1, -1).split(',').map(Number),
  })(name);

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
  embedding: vector('embedding', { dimensions: 1536 }),
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
  embedding: vector('embedding', { dimensions: 1536 }),
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
  whatsappChatId: text('whatsapp_chat_id').notNull(),
  role: text('role').notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'),
  tokensUsed: integer('tokens_used'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  objective: text('objective').notNull(),
  assignedTo: text('assigned_to'),
  status: taskStatusEnum('status').notNull(),
  input: jsonb('input'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const llmCosts = pgTable('llm_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id),
  taskId: uuid('task_id').references(() => tasks.id),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull(),
  completionTokens: integer('completion_tokens').notNull(),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const llmBudgets = pgTable('llm_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  whatsappChatId: text('whatsapp_chat_id').notNull(),
  dailyLimitUsd: numeric('daily_limit_usd', { precision: 10, scale: 2 }),
  monthlyLimitUsd: numeric('monthly_limit_usd', { precision: 10, scale: 2 }),
  currentDailyUsd: numeric('current_daily_usd', { precision: 10, scale: 6 }).default('0'),
  currentMonthlyUsd: numeric('current_monthly_usd', { precision: 10, scale: 6 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
