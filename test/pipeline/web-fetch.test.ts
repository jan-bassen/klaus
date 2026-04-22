import { beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted mocks for use in vi.mock factories
const mocks = vi.hoisted(() => ({
	mockDefuddle: vi.fn(async () => ({
		content: "# Parsed Article\n\nThis is the main content.",
		title: "Test Article",
		wordCount: 6,
	})),
}));

// Mock defuddle/node — must be registered before importing the module under test.
vi.mock("defuddle/node", () => ({
	Defuddle: mocks.mockDefuddle,
}));

// Mock linkedom
vi.mock("linkedom", () => ({
	parseHTML: (html: string) => ({ document: { html } }),
}));

const { extractUrls, fetchWebContent } = await import("@/pipeline/attachments");

beforeEach(() => {
	mocks.mockDefuddle.mockClear();
});

// ─── extractUrls ─────────────────────────────────────────────────────────────

describe("extractUrls", () => {
	test("extracts HTTP and HTTPS urls from text", () => {
		const text = "Check out https://example.com and http://foo.bar/page?q=1";
		expect(extractUrls(text)).toEqual([
			"https://example.com",
			"http://foo.bar/page?q=1",
		]);
	});

	test("deduplicates repeated urls", () => {
		const text = "https://x.com/a https://x.com/a https://x.com/b";
		expect(extractUrls(text)).toEqual(["https://x.com/a", "https://x.com/b"]);
	});

	test("returns empty array when no urls", () => {
		expect(extractUrls("no links here")).toEqual([]);
		expect(extractUrls("")).toEqual([]);
	});

	test("stops at angle brackets and quotes", () => {
		const text = 'Visit <https://skip.com> or "https://also.com/path"';
		const urls = extractUrls(text);
		expect(urls.length).toBeGreaterThan(0);
		for (const u of urls) {
			expect(u).not.toContain("<");
			expect(u).not.toContain('"');
		}
	});

	test("strips trailing punctuation", () => {
		expect(extractUrls("see https://example.com.")[0]).toBe(
			"https://example.com",
		);
		expect(extractUrls("go to https://example.com, ok?")[0]).toBe(
			"https://example.com",
		);
		expect(extractUrls("check https://example.com!")[0]).toBe(
			"https://example.com",
		);
	});

	test("strips unbalanced trailing parens (chat wrapping)", () => {
		const text = "See (https://example.com/path) for details";
		expect(extractUrls(text)[0]).toBe("https://example.com/path");
	});

	test("preserves balanced parens in URLs (Wikipedia-style)", () => {
		const text = "Read https://en.wikipedia.org/wiki/Fish_(animal) for more";
		expect(extractUrls(text)[0]).toBe(
			"https://en.wikipedia.org/wiki/Fish_(animal)",
		);
	});

	test("handles Wikipedia URL wrapped in parens", () => {
		const text = "(https://en.wikipedia.org/wiki/Fish_(animal)) is interesting";
		expect(extractUrls(text)[0]).toBe(
			"https://en.wikipedia.org/wiki/Fish_(animal)",
		);
	});
});

// ─── fetchWebContent ─────────────────────────────────────────────────────────

describe("fetchWebContent", () => {
	const originalFetch = globalThis.fetch;

	function mockFetch(
		body: string,
		opts?: { status?: number; contentType?: string },
	) {
		const status = opts?.status ?? 200;
		const contentType = opts?.contentType ?? "text/html; charset=utf-8";

		globalThis.fetch = vi.fn(async () => ({
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers({ "content-type": contentType }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			}),
		})) as unknown as typeof fetch;
	}

	beforeEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("fetches and parses HTML content", async () => {
		mockFetch("<html><body><p>Hello</p></body></html>");

		const result = await fetchWebContent("https://example.com/page");
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) throw result;

		expect(result.title).toBe("Test Article");
		expect(result.text).toContain("Parsed Article");
		expect(mocks.mockDefuddle).toHaveBeenCalledTimes(1);
	});

	test("returns cached result on second call", async () => {
		mockFetch("<html><body>cached</body></html>");

		const first = await fetchWebContent("https://cached.example.com");
		expect(first).not.toBeInstanceOf(Error);

		// Reset fetch mock to ensure it's not called again
		const secondFetch = vi.fn(async () => {
			throw new Error("should not be called");
		});
		globalThis.fetch = secondFetch as unknown as typeof fetch;

		const second = await fetchWebContent("https://cached.example.com");
		expect(second).not.toBeInstanceOf(Error);
		if (first instanceof Error || second instanceof Error) throw new Error();
		expect(second.title).toBe(first.title);
		expect(secondFetch).not.toHaveBeenCalled();
	});

	test("returns Error for non-OK HTTP status", async () => {
		mockFetch("Not Found", { status: 404 });

		const result = await fetchWebContent("https://example.com/missing");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("404");
	});

	test("returns Error for non-text content types", async () => {
		mockFetch("binary", { contentType: "application/pdf" });

		const result = await fetchWebContent("https://example.com/file.pdf");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("Non-text content type");
	});

	test("handles text/plain without defuddle", async () => {
		mockFetch("Plain text content here", { contentType: "text/plain" });

		const result = await fetchWebContent("https://example.com/raw.txt");
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) throw result;

		expect(result.text).toBe("Plain text content here");
		expect(result.title).toBe("https://example.com/raw.txt");
		expect(mocks.mockDefuddle).not.toHaveBeenCalled();
	});

	test("returns Error when response body exceeds maxBodyBytes", async () => {
		// Create a stream that sends chunks exceeding the 5MB limit
		const bigChunk = new Uint8Array(6_000_000);

		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "text/html" }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bigChunk);
					controller.close();
				},
			}),
		})) as unknown as typeof fetch;

		const result = await fetchWebContent("https://example.com/huge");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("too large");
	});

	test("returns Error when defuddle throws", async () => {
		mockFetch("<html><body>bad</body></html>");
		mocks.mockDefuddle.mockImplementationOnce(async () => {
			throw new Error("defuddle parse error");
		});

		const result = await fetchWebContent("https://example.com/bad");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("defuddle parse error");
	});
});
