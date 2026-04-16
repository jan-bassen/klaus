import { describe, expect, test } from "bun:test";
import type { InboundMessage, TurnContext } from "@/types";
import { type LinksNamespace, linksVariable } from "@/variables/links";

function makeTurn(msg?: InboundMessage) {
	const turn: Omit<TurnContext, "vars"> & {
		vars?: Record<string, unknown>;
	} = {
		chatId: "test",
		agent: {} as TurnContext["agent"],
		overrides: {},
		config: {} as TurnContext["config"],
		vars: {},
		messageRefs: {},
	};
	if (msg) turn.message = msg;
	return turn;
}

const baseMsg: InboundMessage = {
	kind: "whatsapp",
	id: "1",
	chatId: "test",
	senderId: "s",
	text: "check this",
	timestamp: new Date(),
	messageKey: {},
};

describe("linksVariable", () => {
	test("returns empty items when message has no links", async () => {
		const result = (await linksVariable.run(
			makeTurn(baseMsg),
		)) as LinksNamespace;
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
	});

	test("returns empty items when message is undefined", async () => {
		const result = (await linksVariable.run(makeTurn())) as LinksNamespace;
		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
	});

	test("passes through link data from message", async () => {
		const msg: InboundMessage = {
			...baseMsg,
			links: [
				{ url: "https://a.com", title: "Page A", text: "Content A" },
				{ url: "https://b.com", title: "Page B", text: "Content B" },
			],
		};

		const result = (await linksVariable.run(makeTurn(msg))) as LinksNamespace;
		expect(result.count).toBe(2);
		expect(result.items[0]?.url).toBe("https://a.com");
		expect(result.items[1]?.title).toBe("Page B");
	});
});
