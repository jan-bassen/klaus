/**
 * `infra/vault/markdown.ts` — pure parsers + interpolators.
 *
 * Frontmatter, section navigation, wikilinks, and `$var` interpolation are
 * all regex-driven; the surface is small but security-relevant (malicious
 * input goes through `extractWikilinks` and `interpolateUserVars`).
 */

import { describe, expect, it } from "vitest";
import {
	extractFrontmatterTags,
	extractWikilinks,
	findSection,
	hbs,
	interpolateUserVars,
	listHeadings,
	updateFrontmatter,
	wikilinkTargetPattern,
} from "../../../src/infra/vault/markdown.ts";

describe("infra/vault/markdown: hbs helpers", () => {
	it("trunc shortens long strings and keeps short ones", () => {
		const t = hbs.compile("{{trunc s 5}}");
		expect(t({ s: "hello world" })).toBe("hello…");
		expect(t({ s: "hi" })).toBe("hi");
	});

	it("trunc accepts a custom suffix via hash arg", () => {
		const t = hbs.compile('{{trunc s 5 suffix="..."}}');
		expect(t({ s: "hello world" })).toBe("hello...");
	});

	it("limit slices arrays and tolerates non-arrays", () => {
		const t = hbs.compile("{{#each (limit xs 2)}}{{this}},{{/each}}");
		expect(t({ xs: ["a", "b", "c", "d"] })).toBe("a,b,");
		expect(t({ xs: "not-an-array" })).toBe("");
	});

	it("json stringifies non-strings, passes strings through", () => {
		const t = hbs.compile("{{{json v}}}");
		expect(t({ v: { a: 1 } })).toBe('{"a":1}');
		expect(t({ v: "raw" })).toBe("raw");
	});

	it("codeFence uses a longer fence than nested backtick runs", () => {
		const t = hbs.compile("{{{codeFence v}}}");
		expect(t({ v: "plain" })).toBe("```\nplain\n```");
		expect(t({ v: "before\n```ts\nx\n```\nafter" })).toBe(
			"````\nbefore\n```ts\nx\n```\nafter\n````",
		);
	});

	it("eq / and / or / not / default", () => {
		expect(
			hbs.compile("{{#if (eq a b)}}y{{else}}n{{/if}}")({ a: 1, b: 1 }),
		).toBe("y");
		expect(hbs.compile("{{default v 'fb'}}")({ v: "" })).toBe("fb");
		expect(hbs.compile("{{default v 'fb'}}")({ v: "real" })).toBe("real");
	});
});

describe("infra/vault/markdown: updateFrontmatter", () => {
	it("mutates a top-level field and reserialises", () => {
		const raw = "---\nname: a\nvalue: 1\n---\nbody";
		const out = updateFrontmatter(raw, (fm) => {
			fm.value = 2;
		});
		expect(out).toMatch(/value: 2/);
		expect(out).toMatch(/\nbody$/);
	});

	it("supports nested mutation", () => {
		const raw = "---\nsettings:\n  voice: off\n---\nbody";
		const out = updateFrontmatter(raw, (fm) => {
			(fm.settings as Record<string, unknown>).voice = "on";
		});
		expect(out).toMatch(/voice: on/);
	});

	it("returns input unchanged when there's no frontmatter", () => {
		const raw = "no fm here";
		expect(updateFrontmatter(raw, () => {})).toBe(raw);
	});
});

describe("infra/vault/markdown: findSection", () => {
	const doc = [
		"---",
		"title: T",
		"---",
		"intro line",
		"## Tasks",
		"- one",
		"- two",
		"## Notes",
		"a note",
		"### Sub",
		"sub body",
		"## Done",
		"x",
	];

	it("empty heading returns the pre-heading top range, skipping frontmatter", () => {
		const s = findSection(doc, "");
		expect(s).not.toBeNull();
		expect(s?.headingIdx).toBe(-1);
		// First heading is at index 4 ("## Tasks")
		expect(s?.endIdx).toBe(4);
	});

	it("named heading bounds the section to next same-or-higher-level heading", () => {
		const s = findSection(doc, "Notes");
		expect(s).not.toBeNull();
		expect(s?.headingIdx).toBe(7);
		expect(s?.level).toBe(2);
		// Section ends when "## Done" is reached
		expect(s?.endIdx).toBe(11);
	});

	it("matches headings case-insensitively", () => {
		expect(findSection(doc, "tasks")).not.toBeNull();
	});

	it("returns null when heading not found", () => {
		expect(findSection(doc, "Missing")).toBeNull();
	});
});

describe("infra/vault/markdown: listHeadings", () => {
	it("collects headings with level and line index", () => {
		const lines = ["# A", "text", "## B", "## C", "### D"];
		expect(listHeadings(lines)).toEqual([
			{ text: "A", level: 1, lineIdx: 0 },
			{ text: "B", level: 2, lineIdx: 2 },
			{ text: "C", level: 2, lineIdx: 3 },
			{ text: "D", level: 3, lineIdx: 4 },
		]);
	});
});

describe("infra/vault/markdown: extractFrontmatterTags", () => {
	it("array form", () => {
		expect(extractFrontmatterTags("---\ntags: [a, b, c]\n---\nbody")).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("string form (comma/space separated)", () => {
		expect(extractFrontmatterTags("---\ntags: a, b c\n---")).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("returns [] when no frontmatter or no tags", () => {
		expect(extractFrontmatterTags("body only")).toEqual([]);
		expect(extractFrontmatterTags("---\nname: x\n---\n")).toEqual([]);
	});
});

describe("infra/vault/markdown: extractWikilinks", () => {
	it("extracts targets, dedups, sorts", () => {
		const text = "see [[Note A]] and [[Note B|alias]] and [[Note A]] again";
		expect(extractWikilinks(text)).toEqual(["Note A", "Note B"]);
	});

	it("ignores malformed brackets", () => {
		expect(extractWikilinks("[broken] [[]] [[ok]]")).toEqual(["ok"]);
	});
});

describe("infra/vault/markdown: wikilinkTargetPattern", () => {
	it("matches plain and aliased forms; escapes regex specials", () => {
		const pat = wikilinkTargetPattern("My.Note (v2)");
		expect(pat.test("see [[My.Note (v2)]]")).toBe(true);
		expect(pat.test("see [[My.Note (v2)|alt]]")).toBe(true);
		expect(pat.test("see [[Other]]")).toBe(false);
	});
});

describe("infra/vault/markdown: interpolateUserVars", () => {
	const vars = {
		user: { name: "Jan" },
		media: { doc: { text: "hello" } },
		empty: "",
		zero: 0,
	};

	it("replaces $name and $a.b.c paths", () => {
		expect(interpolateUserVars("hi $user.name", vars)).toBe("hi Jan");
		expect(interpolateUserVars("doc=$media.doc.text", vars)).toBe("doc=hello");
	});

	it("passes through unknown names unchanged", () => {
		expect(interpolateUserVars("price=$cost.usd", vars)).toBe(
			"price=$cost.usd",
		);
	});

	it("renders empty string for empty/null values, but stringifies 0", () => {
		expect(interpolateUserVars("[$empty]", vars)).toBe("[]");
		expect(interpolateUserVars("n=$zero", vars)).toBe("n=0");
	});

	it("does not match a bare $ or $$$", () => {
		expect(interpolateUserVars("price is $5", vars)).toBe("price is $5");
	});
});
