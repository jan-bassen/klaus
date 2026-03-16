import { z } from "zod";

// -- Conversation events --

const ConversationMessageEventSchema = z.object({
	kind: z.literal("msg"),
	id: z.string(),
	role: z.enum(["user", "assistant"]),
	content: z.string().nullable(),
	createdAt: z.string(),
	externalId: z.string().optional(),
	quotedText: z.string().optional(),
	quotedRole: z.string().optional(),
	flags: z.array(z.string()).optional(),
	command: z.string().nullable().optional(),
});

const ConversationAckEventSchema = z.object({
	kind: z.literal("ack"),
	messageId: z.string(),
	externalId: z.string(),
});

const ConversationReactionEventSchema = z.object({
	kind: z.literal("reaction"),
	messageExternalId: z.string(),
	emoji: z.string(),
	senderId: z.string(),
	fromMe: z.boolean(),
});

export const ConversationEventSchema = z.discriminatedUnion("kind", [
	ConversationMessageEventSchema,
	ConversationAckEventSchema,
	ConversationReactionEventSchema,
]);

// -- Tasks --

export const TaskRecordSchema = z.object({
	id: z.string(),
	chatId: z.string(),
	objective: z.string(),
	assignedTo: z.string().optional(),
	caller: z.string().optional(),
	status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
	result: z.unknown().optional(),
	parentTaskId: z.string().optional(),
	createdAt: z.string(),
	completedAt: z.string().optional(),
});

// -- Files --

export const FileMetaSchema = z.object({
	id: z.string(),
	path: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number(),
	messageId: z.string().optional(),
	externalId: z.string().optional(),
	createdAt: z.string(),
});

// -- Budgets --

export const BudgetConfigSchema = z.object({
	chatId: z.string(),
	dailyLimitUsd: z.number().optional(),
	monthlyLimitUsd: z.number().optional(),
});

// -- Schedules --

export const ScheduleEntrySchema = z.object({
	name: z.string(),
	agentName: z.string(),
	pattern: z.string(),
	chatId: z.string(),
	payload: z.record(z.unknown()),
	createdAt: z.string(),
});
