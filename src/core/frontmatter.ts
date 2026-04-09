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
