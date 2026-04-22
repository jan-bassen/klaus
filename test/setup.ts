import { beforeEach } from "vitest";

/**
 * Install a minimal Services container before every test. Store slots are
 * throwing stubs — tests that need real stores call `installTestServices()`
 * from test/helpers/services to override. This keeps setup robust for tests
 * that mock store modules wholesale (so `createXStore` is undefined).
 *
 * All imports are dynamic so setup files don't freeze module bindings before
 * per-file vi.mock calls get a chance to register.
 */
beforeEach(async () => {
	const { createRateLimiter } = await import("@/pipeline/rate-limit");
	const { setServices } = await import("@/services");

	const defaults = new Map<string, string>();
	const stub = (name: string) =>
		new Proxy(
			{},
			{
				get() {
					return () => {
						throw new Error(
							`test/setup.ts: ${name} store not installed. Call installTestServices({ dataDir: tmp }) in the test's beforeEach.`,
						);
					};
				},
			},
		);

	// biome-ignore lint/suspicious/noExplicitAny: intentional — sub-fields are Proxy stubs typed dynamically
	const services: any = {
		conversations: stub("conversations"),
		files: stub("files"),
		timers: stub("timers"),
		schedules: stub("schedules"),
		rateLimiter: createRateLimiter(),
		defaultAgents: {
			get: (chatId: string) => defaults.get(chatId) ?? "assistant",
			set: (chatId: string, agent: string | null) => {
				if (agent === null) defaults.delete(chatId);
				else defaults.set(chatId, agent);
			},
		},
	};
	setServices(services);
});
