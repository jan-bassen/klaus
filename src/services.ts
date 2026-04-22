import { settings } from "@/config";
import { createRateLimiter, type RateLimitResult } from "@/pipeline/rate-limit";
import {
	type ConversationMessage,
	createConversationStore,
	type TraceStep,
} from "@/store/conversation";
import { createFileStore, type FileMeta } from "@/store/files";
import { createScheduleStore, type ScheduleEntry } from "@/store/schedules";
import { createTimerStore, type TimerEntry } from "@/store/timers";
import type { InboundMessage } from "@/types";

export interface ConversationStore {
	appendMessage(msg: {
		role: "user" | "assistant";
		content: string | null;
		externalId?: string;
		quotedText?: string;
		quotedRole?: string;
		overrides?: string[];
		command?: string | null;
	}): Promise<string>;
	appendAck(messageId: string, externalId: string): Promise<void>;
	appendReaction(reaction: {
		messageExternalId: string;
		emoji: string;
		senderId: string;
		fromMe: boolean;
	}): Promise<void>;
	appendTrace(messageId: string, steps: TraceStep[]): Promise<void>;
	appendBreak(): Promise<void>;
	appendSupersede(messageId: string, reason?: string): Promise<void>;
	getConversation(): Promise<ConversationMessage[]>;
	readAllMessages(): Promise<ConversationMessage[]>;
	searchConversation(opts: {
		query?: string;
		around?: string;
		before?: string;
		after?: string;
		limit?: number;
		contextWindow?: number;
	}): Promise<ConversationMessage[]>;
	findByExternalId(externalId: string): { messageId: string } | null;
	resolveExternalId(externalId: string): string | null;
	resolveMessageId(messageId: string): string | null;
	getTraces(): Promise<Map<string, TraceStep[]>>;
	rebuildIndexes(): Promise<void>;
}

export interface FileStore {
	saveFileMeta(meta: {
		path: string;
		mimeType: string;
		sizeBytes: number;
		messageId?: string;
		externalId?: string;
	}): Promise<{ id: string; path: string } | Error>;
	updateFileMessageId(
		fileId: string,
		messageId: string,
	): Promise<undefined | Error>;
	findFile(fileId: string): FileMeta | null;
	findFileByMessageId(
		messageId: string,
	): { fileId: string; path: string; mimeType: string } | null;
	findFileByExternalId(
		externalId: string,
	): { fileId: string; path: string; mimeType: string } | null;
	listFiles(prefix?: string): FileMeta[];
	deleteFile(fileId: string): boolean;
	rebuildIndex(): Promise<void>;
}

export interface TimerStore {
	setOnFire(fn: (entry: TimerEntry) => Promise<void>): void;
	load(): Promise<void>;
	add(entry: TimerEntry): Promise<void>;
	remove(id: string): Promise<boolean>;
	list(): TimerEntry[];
	stopAll(): void;
}

export interface ScheduleStore {
	setOnFire(fn: (entry: ScheduleEntry) => Promise<void>): void;
	load(): Promise<void>;
	add(entry: ScheduleEntry): Promise<void>;
	remove(id: string): Promise<boolean>;
	list(): ScheduleEntry[];
	startAll(): void;
	stopAll(): void;
	find(agentName: string, label?: string): ScheduleEntry | undefined;
}

export interface RateLimiter {
	checkMessage(msg: InboundMessage): RateLimitResult;
	checkModel(): RateLimitResult;
}

export interface DefaultAgentRegistry {
	get(chatId: string): string;
	set(chatId: string, agent: string | null): void;
}

export interface Services {
	conversations: ConversationStore;
	files: FileStore;
	timers: TimerStore;
	schedules: ScheduleStore;
	rateLimiter: RateLimiter;
	defaultAgents: DefaultAgentRegistry;
}

export interface ServicesEnv {
	dataDir: string;
	timezone: string;
}

let services: Services | null = null;

export function setServices(next: Services | null): void {
	services = next;
}

export function getServices(): Services {
	if (!services) {
		throw new Error(
			"Services container not initialised. Call setServices(createServices(...)) at bootstrap, or setServices(createTestServices()) in tests.",
		);
	}
	return services;
}

export function createServices(env: ServicesEnv): Services {
	return {
		conversations: createConversationStore({ dataDir: env.dataDir }),
		files: createFileStore({ dataDir: env.dataDir }),
		timers: createTimerStore({ dataDir: env.dataDir }),
		schedules: createScheduleStore({
			dataDir: env.dataDir,
			timezone: env.timezone,
		}),
		rateLimiter: createRateLimiter(),
		defaultAgents: createDefaultAgentRegistry(),
	};
}

// Inlined here (rather than in agent/definitions.ts) so services.ts doesn't
// pull in the full agent schema at module-load time. Tests that mock @/config
// partially would otherwise break on missing `modelTiers`.
function createDefaultAgentRegistry(): DefaultAgentRegistry {
	const overrides = new Map<string, string>();
	return {
		get: (chatId: string) => overrides.get(chatId) ?? settings.defaultAgent,
		set: (chatId: string, agent: string | null) => {
			if (agent === null) overrides.delete(chatId);
			else overrides.set(chatId, agent);
		},
	};
}
