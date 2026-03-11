import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { _disableForTest, _enableForTest, log } from "@/logger";

describe("log", () => {
	let logLines: string[] = [];
	let errorLines: string[] = [];
	const origLog = console.log;
	const origError = console.error;

	beforeAll(() => {
		_enableForTest();
	});
	afterAll(() => {
		_disableForTest();
	});

	beforeEach(() => {
		logLines = [];
		errorLines = [];
		console.log = (s: string) => {
			logLines.push(s);
		};
		console.error = (s: string) => {
			errorLines.push(s);
		};
	});

	afterEach(() => {
		console.log = origLog;
		console.error = origError;
	});

	test("output is valid JSON with ts, level, and msg fields", () => {
		log.info("test message");
		expect(logLines).toHaveLength(1);
		const parsed = JSON.parse(logLines[0] ?? "{}");
		expect(parsed.ts).toBeDefined();
		expect(parsed.level).toBe("info");
		expect(parsed.msg).toBe("test message");
	});

	test("ts is an ISO 8601 timestamp", () => {
		log.info("ts check");
		const { ts } = JSON.parse(logLines[0] ?? "{}");
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	test("info and debug write to console.log, not console.error", () => {
		log.info("info msg");
		log.debug("debug msg");
		expect(logLines).toHaveLength(2);
		expect(errorLines).toHaveLength(0);
	});

	test("warn and error write to console.error, not console.log", () => {
		log.warn("warn msg");
		log.error("error msg");
		expect(errorLines).toHaveLength(2);
		expect(logLines).toHaveLength(0);
	});

	test("extra data fields are merged into the JSON object", () => {
		log.info("with data", { chatId: "abc@s.whatsapp.net", count: 3 });
		const parsed = JSON.parse(logLines[0] ?? "{}");
		expect(parsed.chatId).toBe("abc@s.whatsapp.net");
		expect(parsed.count).toBe(3);
		expect(parsed.msg).toBe("with data");
	});

	test("works without a data argument — no extra fields beyond ts/level/msg", () => {
		log.info("bare message");
		const parsed = JSON.parse(logLines[0] ?? "{}");
		expect(Object.keys(parsed)).toEqual(["ts", "level", "msg"]);
	});
});
