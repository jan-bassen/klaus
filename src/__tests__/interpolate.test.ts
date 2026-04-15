import { describe, expect, test } from "bun:test";
import { hbs, interpolateUserVars } from "@/markdown";

describe("interpolateUserVars", () => {
	const vars = {
		time: { date: "Monday, April 7, 2026", time: "14:30 CEST" },
		tasks: {
			active: [{ kind: "running", objective: "fitness check" }],
		},
		empty_var: "",
	};

	test("resolves dot-paths", () => {
		expect(interpolateUserVars("Today is $time.date", vars)).toBe(
			"Today is Monday, April 7, 2026",
		);
	});

	test("replaces multiple refs", () => {
		expect(interpolateUserVars("$time.date at $time.time", vars)).toBe(
			"Monday, April 7, 2026 at 14:30 CEST",
		);
	});

	test("unknown $var passes through unchanged", () => {
		expect(interpolateUserVars("price is $amount", vars)).toBe(
			"price is $amount",
		);
	});

	test("empty string value collapses", () => {
		expect(interpolateUserVars("val: $empty_var end", vars)).toBe("val:  end");
	});

	test("plain text returns unchanged", () => {
		expect(interpolateUserVars("just plain text", vars)).toBe(
			"just plain text",
		);
	});

	test("$ not followed by word char passes through", () => {
		expect(interpolateUserVars("costs $5", vars)).toBe("costs $5");
	});

	test("object value serializes via String() (used only as escape hatch)", () => {
		expect(interpolateUserVars("$tasks.active", vars)).toContain("object");
	});
});

describe("handlebars helpers", () => {
	test("trunc shortens long strings with ellipsis", () => {
		const tpl = hbs.compile("{{trunc value 5}}");
		expect(tpl({ value: "abcdefghij" })).toBe("abcde…");
	});

	test("trunc leaves short strings alone", () => {
		const tpl = hbs.compile("{{trunc value 20}}");
		expect(tpl({ value: "short" })).toBe("short");
	});

	test("trunc custom suffix", () => {
		const tpl = hbs.compile('{{trunc value 3 suffix="..."}}');
		expect(tpl({ value: "abcdef" })).toBe("abc...");
	});

	test("trunc handles nested values via dot-path", () => {
		const tpl = hbs.compile("{{trunc media.doc.text 5}}");
		expect(tpl({ media: { doc: { text: "abcdefghij" } } })).toBe("abcde…");
	});

	test("limit slices arrays", () => {
		const tpl = hbs.compile("{{#each (limit items 2)}}{{this}}{{/each}}");
		expect(tpl({ items: ["a", "b", "c", "d"] })).toBe("ab");
	});

	test("limit on non-array returns empty", () => {
		const tpl = hbs.compile("{{#each (limit items 2)}}x{{/each}}");
		expect(tpl({ items: "not an array" })).toBe("");
	});
});
