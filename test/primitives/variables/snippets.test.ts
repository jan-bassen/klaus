/**
 * `primitives/variables/snippets.ts` — file → namespace compilation.
 *
 * Covers frontmatter stripping, Handlebars interpolation against the partial
 * variable namespace, recursive `{{snippets.*}}` references with fixed-point
 * resolution, and graceful handling of cycles + bad templates.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "@/infra/config";
import type { TurnContext } from "@/pipeline/core";
import { snippetsVariable } from "@/primitives/variables/snippets";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";
import { makeTurn } from "../../helpers/turn";

function writeSnippet(dir: string, name: string, body: string): void {
	writeFileSync(path.join(dir, `${name}.md`), body);
}

interface RunArg extends Omit<TurnContext, "vars"> {
	vars?: Record<string, unknown>;
}

async function runSnippets(
	vars: Record<string, unknown> = {},
): Promise<Record<string, string>> {
	const turn = makeTurn() as unknown as RunArg;
	turn.vars = vars;
	const out = await snippetsVariable.run(turn);
	return out as Record<string, string>;
}

describe("primitives/variables/snippets", () => {
	let tmp: string;
	let saved: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		saved = settings.vault.snippetsDir;
		settings.vault.snippetsDir = tmp;
	});

	afterEach(() => {
		settings.vault.snippetsDir = saved;
		rmTmpDir(tmp);
	});

	it("loads snippet bodies and strips YAML frontmatter", async () => {
		writeSnippet(
			tmp,
			"voice",
			"---\ndescription: speak\n---\nBe terse and direct.",
		);
		const out = await runSnippets();
		expect(out.voice).toBe("Be terse and direct.");
	});

	it("excludes the special user.md file (owned by user variable)", async () => {
		writeSnippet(tmp, "user", "name: Jan");
		writeSnippet(tmp, "tone", "polite");
		const out = await runSnippets();
		expect(out.user).toBeUndefined();
		expect(out.tone).toBe("polite");
	});

	it("interpolates other variables from the namespace", async () => {
		writeSnippet(tmp, "greet", "Hi {{user.name}}, it's {{time.hour}}h.");
		const out = await runSnippets({
			user: { name: "Jan" },
			time: { hour: 9 },
		});
		expect(out.greet).toBe("Hi Jan, it's 9h.");
	});

	it("returns body verbatim when there are no Handlebars expressions", async () => {
		writeSnippet(tmp, "static", "Just plain text.");
		const out = await runSnippets({ user: { name: "Jan" } });
		expect(out.static).toBe("Just plain text.");
	});

	it("resolves snippet-to-snippet references via fixed-point iteration", async () => {
		writeSnippet(tmp, "name", "Klaus");
		writeSnippet(tmp, "greet", "Hello, {{snippets.name}}!");
		writeSnippet(tmp, "outer", "[{{snippets.greet}}]");
		const out = await runSnippets();
		expect(out.name).toBe("Klaus");
		expect(out.greet).toBe("Hello, Klaus!");
		expect(out.outer).toBe("[Hello, Klaus!]");
	});

	it("falls back to raw content when Handlebars compilation throws", async () => {
		// Unclosed expression triggers a parse error inside hbs.compile.
		writeSnippet(tmp, "broken", "Hello {{unclosed");
		const out = await runSnippets();
		expect(out.broken).toBe("Hello {{unclosed");
	});

	it("does not infinitely loop on a self-referential cycle", async () => {
		writeSnippet(tmp, "a", "A:{{snippets.b}}");
		writeSnippet(tmp, "b", "B:{{snippets.a}}");
		const out = await runSnippets();
		// Should return without hanging; the result is whatever the bounded
		// iteration produced — we only assert it's a string for each key.
		expect(typeof out.a).toBe("string");
		expect(typeof out.b).toBe("string");
	});

	it("returns empty object when snippets directory is empty", async () => {
		const out = await runSnippets();
		expect(out).toEqual({});
	});

	it("does not escape HTML / angle brackets (noEscape mode)", async () => {
		writeSnippet(tmp, "html", "{{user.tag}}");
		const out = await runSnippets({ user: { tag: "<b>bold</b> & co" } });
		expect(out.html).toBe("<b>bold</b> & co");
	});
});
