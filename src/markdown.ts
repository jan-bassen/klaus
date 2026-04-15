import Handlebars from "handlebars";

// -- Handlebars instance --

/** Isolated Handlebars instance — never touches the global registry. */
const hbs = Handlebars.create();

// -- Comparison --
hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hbs.registerHelper("ne", (a: unknown, b: unknown) => a !== b);
hbs.registerHelper("lt", (a: unknown, b: unknown) => Number(a) < Number(b));
hbs.registerHelper("gt", (a: unknown, b: unknown) => Number(a) > Number(b));

// -- Logic --
hbs.registerHelper("and", (...args: unknown[]) =>
	args.slice(0, -1).every(Boolean),
);
hbs.registerHelper("or", (...args: unknown[]) =>
	args.slice(0, -1).some(Boolean),
);
hbs.registerHelper("not", (a: unknown) => !a);

// -- Utility --
hbs.registerHelper(
	"default",
	(val: unknown, fallback: unknown) => val || fallback,
);
hbs.registerHelper("join", (arr: unknown, sep: unknown) =>
	Array.isArray(arr) ? arr.join(String(sep)) : arr,
);

/** Hard char cap. `{{trunc text 5000}}` — returns up to `max` chars, appending `…` when truncated. */
hbs.registerHelper(
	"trunc",
	(value: unknown, max: unknown, options: unknown) => {
		const str = value == null ? "" : String(value);
		const n = Number(max);
		if (!Number.isFinite(n) || n <= 0 || str.length <= n) return str;
		// Options is Handlebars' final arg — allow an explicit suffix via hash: {{trunc x 5000 suffix="..."}}
		const hash = (options as { hash?: { suffix?: string } } | undefined)?.hash;
		const suffix = typeof hash?.suffix === "string" ? hash.suffix : "…";
		return str.slice(0, n) + suffix;
	},
);

/** `{{limit array 5}}` — slice array to first N elements. Returns empty array for non-arrays. */
hbs.registerHelper("limit", (arr: unknown, n: unknown) => {
	const count = Number(n);
	if (!Array.isArray(arr) || !Number.isFinite(count)) return [];
	return arr.slice(0, count);
});

export { hbs };

// -- Frontmatter --

export function setFrontmatterField(
	raw: string,
	field: string,
	value: string,
): string {
	const fieldRegex = new RegExp(
		`^(---\\n[\\s\\S]*?)${field}:\\s*\\S+([\\s\\S]*?\\n---)`,
	);
	if (fieldRegex.test(raw)) {
		return raw.replace(fieldRegex, `$1${field}: ${value}$2`);
	}
	return raw.replace(/\n---/, `\n${field}: ${value}\n---`);
}

export function removeFrontmatterField(raw: string, field: string): string {
	const fieldRegex = new RegExp(`\\n${field}:\\s*\\S+`, "");
	return raw.replace(fieldRegex, "");
}

// -- Interpolation --

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

/**
 * Read a .md prompt file and return the body after stripping YAML frontmatter.
 * Returns empty string on failure.
 */
export async function readPromptBody(promptPath: string): Promise<string> {
	try {
		const raw = await Bun.file(promptPath).text();
		return raw.replace(fmPattern, "").trim();
	} catch {
		return "";
	}
}

// -- User message $var interpolation --

/** Matches `$name` or `$name.sub.path` — used only in raw user-typed message text. */
const dollarVarPattern = /\$([a-zA-Z_][\w.]*)/g;

/** Resolve a dot-path like `media.doc.text` against a nested object. */
function resolvePath(vars: Record<string, unknown>, dotted: string): unknown {
	const parts = dotted.split(".");
	let cur: unknown = vars;
	for (const part of parts) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/**
 * Replace `$name` and `$name.sub` references in user-typed text with values
 * from the unified namespace. Unknown names pass through unchanged.
 */
export function interpolateUserVars(
	text: string,
	vars: Record<string, unknown>,
): string {
	return text.replace(dollarVarPattern, (match, name: string) => {
		const value = resolvePath(vars, name);
		if (value === undefined) return match;
		if (value === null || value === "") return "";
		return String(value);
	});
}
