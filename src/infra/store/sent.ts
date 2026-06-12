import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "../logger.ts";
import { readText } from "../runtime.ts";

interface SentMessageStore {
	markSentMessageId(externalId: string): Promise<void>;
	wasSentMessageId(externalId: string): boolean;
	rebuildIndex(): Promise<void>;
}

interface SentMessageStoreEnv {
	dataDir: string;
}

const SentMessageEventSchema = z.object({
	externalId: z.string(),
	createdAt: z.string(),
});

type SentMessageEvent = z.infer<typeof SentMessageEventSchema>;

function createSentMessageStore(env: SentMessageStoreEnv): SentMessageStore {
	const sentIds = new Set<string>();

	const whatsappDir = (): string => path.join(env.dataDir, "whatsapp");
	const sentPath = (): string => path.join(whatsappDir(), "sent-ids.jsonl");

	async function ensureDir(): Promise<void> {
		await mkdir(whatsappDir(), { recursive: true });
	}

	async function appendEvent(event: SentMessageEvent): Promise<void> {
		await ensureDir();
		await appendFile(sentPath(), `${JSON.stringify(event)}\n`);
	}

	async function markSentMessageId(externalId: string): Promise<void> {
		if (sentIds.has(externalId)) return;
		const event: SentMessageEvent = {
			externalId,
			createdAt: new Date().toISOString(),
		};
		await appendEvent(event);
		sentIds.add(externalId);
	}

	function wasSentMessageId(externalId: string): boolean {
		return sentIds.has(externalId);
	}

	async function rebuildIndex(): Promise<void> {
		sentIds.clear();
		try {
			await readdir(whatsappDir());
		} catch {
			return;
		}

		let text: string;
		try {
			text = await readText(sentPath());
		} catch {
			return;
		}

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = SentMessageEventSchema.parse(JSON.parse(line));
				sentIds.add(event.externalId);
			} catch {
				log.warn("[sent] skipping corrupt line in index rebuild", {
					line: line.slice(0, 100),
				});
			}
		}

		log.info(`[sent] index rebuilt (${sentIds.size} ids)`);
	}

	return {
		markSentMessageId,
		wasSentMessageId,
		rebuildIndex,
	};
}

let _store: SentMessageStore | null = null;

export function initSentMessageStore(env: SentMessageStoreEnv): void {
	_store = createSentMessageStore(env);
}

function store(): SentMessageStore {
	if (!_store) throw new Error("[sent] store not initialized");
	return _store;
}

export function markSentMessageId(externalId: string): Promise<void> {
	return store().markSentMessageId(externalId);
}

export function wasSentMessageId(externalId: string): boolean {
	return store().wasSentMessageId(externalId);
}

export function rebuildSentMessageIndex(): Promise<void> {
	return store().rebuildIndex();
}
