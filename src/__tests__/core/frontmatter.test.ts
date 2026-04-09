import { describe, expect, test } from "bun:test";
import {
	removeFrontmatterField,
	setFrontmatterField,
} from "@/core/frontmatter";

const SAMPLE = `---
name: klaus
modelTier: medium
tools: [reply]
---
You are Klaus.
`;

describe("setFrontmatterField", () => {
	test("replaces existing field", () => {
		const result = setFrontmatterField(SAMPLE, "modelTier", "large");
		expect(result).toContain("modelTier: large");
		expect(result).not.toContain("modelTier: medium");
	});

	test("inserts missing field before closing ---", () => {
		const result = setFrontmatterField(SAMPLE, "voiceMode", "on");
		expect(result).toContain("voiceMode: on");
		// Should be inside frontmatter (before ---)
		const fmMatch = result.match(/^---\n([\s\S]*?)\n---/);
		expect(fmMatch?.[1]).toContain("voiceMode: on");
	});

	test("replaces field with similar prefix correctly", () => {
		const withProvider = setFrontmatterField(SAMPLE, "provider", "claude");
		const result = setFrontmatterField(withProvider, "provider", "gemini");
		expect(result).toContain("provider: gemini");
		expect(result).not.toContain("provider: claude");
	});

	test("preserves body content", () => {
		const result = setFrontmatterField(SAMPLE, "voiceMode", "off");
		expect(result).toContain("You are Klaus.");
	});
});

describe("removeFrontmatterField", () => {
	test("removes existing field", () => {
		const withMode = setFrontmatterField(SAMPLE, "voiceMode", "on");
		const result = removeFrontmatterField(withMode, "voiceMode");
		expect(result).not.toContain("voiceMode");
	});

	test("no-op when field does not exist", () => {
		const result = removeFrontmatterField(SAMPLE, "voiceMode");
		expect(result).toBe(SAMPLE);
	});
});
