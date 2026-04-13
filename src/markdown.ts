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

export { hbs };

// -- Frontmatter --

/**
 * Set or insert a YAML frontmatter field in a raw .md file string.
 * If the field exists, replaces its value. If not, inserts before closing ---.
 */
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
	// Field not present — insert before closing ---
	return raw.replace(/\n---/, `\n${field}: ${value}\n---`);
}

/**
 * Remove a YAML frontmatter field from a raw .md file string.
 */
export function removeFrontmatterField(raw: string, field: string): string {
	const fieldRegex = new RegExp(`\\n${field}:\\s*\\S+`, "");
	return raw.replace(fieldRegex, "");
}

// -- Interpolation --

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

/**
 * Read a .md prompt file and return the body after stripping YAML frontmatter.
 * Returns empty string on failure (file not found, etc.).
 */
export async function readPromptBody(promptPath: string): Promise<string> {
	try {
		const raw = await Bun.file(promptPath).text();
		return raw.replace(fmPattern, "").trim();
	} catch {
		return "";
	}
}

// -- Param extraction --

const hbsParamPattern = /\{\{([a-zA-Z_]\w*)\?([^}]+)\}\}/g;
const dollarParamPattern = /\$([a-zA-Z_]\w*)\?(\S+)/g;

/**
 * Extract variable references with ?params from text.
 * Returns a map of varName → parsed params.
 *
 * HBS syntax: {{varName?key=val&key2=val2}}
 * Dollar syntax: $varName?key=val&key2=val2
 */
export function extractVarParams(
	text: string,
	syntax: "hbs" | "dollar",
): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};
	const pattern = syntax === "hbs" ? hbsParamPattern : dollarParamPattern;

	for (const match of text.matchAll(pattern)) {
		const name = match[1];
		const queryString = match[2];
		if (!name || !queryString) continue;
		result[name] = Object.fromEntries(new URLSearchParams(queryString));
	}

	return result;
}

/**
 * Strip ?params from Handlebars variable references.
 * {{tasks?limit=3}} → {{tasks}}
 */
export function stripHbsParams(template: string): string {
	return template.replace(hbsParamPattern, "{{$1}}");
}

// -- User message interpolation --

const dollarVarPattern = /\$([a-zA-Z_]\w*)(\?[^\s]*)?/g;

/**
 * Replace $var and $var?params in user message text with values from vars.
 * Unknown $names pass through unchanged.
 * Params are already applied at run time — this just strips the ?params syntax
 * and resolves the base variable name.
 */
export function interpolateUserVars(
	text: string,
	vars: Record<string, unknown>,
): string {
	return text.replace(dollarVarPattern, (match, name: string) => {
		if (!(name in vars)) return match;
		const value = vars[name];
		if (value === undefined || value === null || value === "") return "";
		return String(value);
	});
}

/**
 * Merge multiple param maps. Later entries override earlier ones per key.
 */
export function mergeVarParams(
	...maps: Record<string, Record<string, string>>[]
): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};
	for (const map of maps) {
		for (const [varName, params] of Object.entries(map)) {
			result[varName] = { ...result[varName], ...params };
		}
	}
	return result;
}
