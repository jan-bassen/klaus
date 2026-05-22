import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import type { TurnContext } from "../../../src/pipeline/core.ts";
import { snippetsVariable } from "../../../src/primitives/variables/snippets.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";
import { makeTurn } from "../../helpers/turn.ts";

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

	it("loads user.md like any other snippet", async () => {
		writeSnippet(tmp, "user", "name: Jan");
		writeSnippet(tmp, "tone", "polite");
		const out = await runSnippets();
		expect(out.user).toBe("name: Jan");
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

	it("does not expand snippet-to-snippet references", async () => {
		writeSnippet(tmp, "name", "Klaus");
		writeSnippet(tmp, "greet", "Hello, {{snippets.name}}!");
		writeSnippet(tmp, "outer", "[{{snippets.greet}}]");
		const out = await runSnippets();
		expect(out.name).toBe("Klaus");
		expect(out.greet).toBe("Hello, !");
		expect(out.outer).toBe("[]");
	});

	it("allows escaped snippet references as literal documentation", async () => {
		writeSnippet(
			tmp,
			"user",
			"Describe yourself.\nThis content is available as \\{{snippets.user}}.",
		);
		const out = await runSnippets();
		expect(out.user).toBe(
			"Describe yourself.\nThis content is available as {{snippets.user}}.",
		);
	});

	it("falls back to raw content when Handlebars compilation throws", async () => {
		// Unclosed expression triggers a parse error inside hbs.compile.
		writeSnippet(tmp, "broken", "Hello {{unclosed");
		const out = await runSnippets();
		expect(out.broken).toBe("Hello {{unclosed");
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
