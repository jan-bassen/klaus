import { describe, expect, test } from "bun:test";
import {
	extractVarParams,
	interpolateUserVars,
	mergeVarParams,
	stripHbsParams,
} from "@/markdown";

describe("extractVarParams", () => {
	describe("hbs syntax", () => {
		test("extracts params from {{var?key=val}}", () => {
			const result = extractVarParams("{{tasks?limit=3}}", "hbs");
			expect(result).toEqual({ tasks: { limit: "3" } });
		});

		test("extracts multiple params", () => {
			const result = extractVarParams("{{tasks?limit=3&sort=asc}}", "hbs");
			expect(result).toEqual({ tasks: { limit: "3", sort: "asc" } });
		});

		test("extracts from multiple vars", () => {
			const result = extractVarParams(
				"{{tasks?limit=3}} and {{active_tasks?limit=5}}",
				"hbs",
			);
			expect(result).toEqual({
				tasks: { limit: "3" },
				active_tasks: { limit: "5" },
			});
		});

		test("ignores vars without params", () => {
			const result = extractVarParams("{{tasks}} {{date}}", "hbs");
			expect(result).toEqual({});
		});

		test("empty string returns empty", () => {
			expect(extractVarParams("", "hbs")).toEqual({});
		});
	});

	describe("dollar syntax", () => {
		test("extracts params from $var?key=val", () => {
			const result = extractVarParams("$tasks?limit=3", "dollar");
			expect(result).toEqual({ tasks: { limit: "3" } });
		});

		test("extracts multiple params", () => {
			const result = extractVarParams("$tasks?limit=3&sort=asc", "dollar");
			expect(result).toEqual({ tasks: { limit: "3", sort: "asc" } });
		});

		test("stops at whitespace", () => {
			const result = extractVarParams("$tasks?limit=3 some text", "dollar");
			expect(result).toEqual({ tasks: { limit: "3" } });
		});

		test("ignores vars without params", () => {
			const result = extractVarParams("$tasks $date", "dollar");
			expect(result).toEqual({});
		});
	});
});

describe("stripHbsParams", () => {
	test("strips params from {{var?params}}", () => {
		expect(stripHbsParams("{{tasks?limit=3}}")).toBe("{{tasks}}");
	});

	test("strips multiple params from multiple vars", () => {
		expect(
			stripHbsParams("{{tasks?limit=3}} and {{active_tasks?sort=asc}}"),
		).toBe("{{tasks}} and {{active_tasks}}");
	});

	test("leaves vars without params unchanged", () => {
		expect(stripHbsParams("{{tasks}} {{date}}")).toBe("{{tasks}} {{date}}");
	});

	test("handles mixed vars with and without params", () => {
		expect(stripHbsParams("{{tasks?limit=3}} {{date}}")).toBe(
			"{{tasks}} {{date}}",
		);
	});
});

describe("interpolateUserVars", () => {
	const vars = {
		date: "Monday, April 7, 2026",
		time: "14:30 CEST",
		active_tasks: "- [running] fitness check",
		empty_var: "",
	};

	test("replaces known $var", () => {
		expect(interpolateUserVars("Today is $date", vars)).toBe(
			"Today is Monday, April 7, 2026",
		);
	});

	test("replaces multiple vars", () => {
		expect(interpolateUserVars("$date at $time", vars)).toBe(
			"Monday, April 7, 2026 at 14:30 CEST",
		);
	});

	test("unknown $var passes through unchanged", () => {
		expect(interpolateUserVars("price is $amount", vars)).toBe(
			"price is $amount",
		);
	});

	test("$var with params resolves to base var value", () => {
		expect(interpolateUserVars("tasks: $active_tasks?limit=3", vars)).toBe(
			"tasks: - [running] fitness check",
		);
	});

	test("empty var value produces empty string", () => {
		expect(interpolateUserVars("val: $empty_var end", vars)).toBe("val:  end");
	});

	test("no vars in text returns unchanged", () => {
		expect(interpolateUserVars("just plain text", vars)).toBe(
			"just plain text",
		);
	});

	test("$ not followed by word char passes through", () => {
		expect(interpolateUserVars("costs $5", vars)).toBe("costs $5");
	});

	test("handles adjacent vars", () => {
		expect(interpolateUserVars("$date$time", vars)).toBe(
			"Monday, April 7, 202614:30 CEST",
		);
	});

	test("empty vars dict leaves all unchanged", () => {
		expect(interpolateUserVars("$date $time", {})).toBe("$date $time");
	});
});

describe("mergeVarParams", () => {
	test("merges multiple maps", () => {
		const a = { tasks: { limit: "3" } };
		const b = { tasks: { sort: "asc" }, date: { format: "short" } };
		expect(mergeVarParams(a, b)).toEqual({
			tasks: { limit: "3", sort: "asc" },
			date: { format: "short" },
		});
	});

	test("later values override earlier", () => {
		const a = { tasks: { limit: "3" } };
		const b = { tasks: { limit: "5" } };
		expect(mergeVarParams(a, b)).toEqual({ tasks: { limit: "5" } });
	});

	test("empty maps", () => {
		expect(mergeVarParams({}, {})).toEqual({});
	});
});
