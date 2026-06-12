import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initSentMessageStore,
	markSentMessageId,
	rebuildSentMessageIndex,
	wasSentMessageId,
} from "../../../src/infra/store/sent.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("infra/store/sent", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initSentMessageStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("tracks sent WhatsApp ids in memory", async () => {
		await markSentMessageId("wa-sent-1");

		expect(wasSentMessageId("wa-sent-1")).toBe(true);
		expect(wasSentMessageId("unknown")).toBe(false);
	});

	it("rebuilds sent WhatsApp ids after restart", async () => {
		await markSentMessageId("wa-sent-2");

		initSentMessageStore({ dataDir: tmpDir });
		expect(wasSentMessageId("wa-sent-2")).toBe(false);

		await rebuildSentMessageIndex();
		expect(wasSentMessageId("wa-sent-2")).toBe(true);
	});
});
