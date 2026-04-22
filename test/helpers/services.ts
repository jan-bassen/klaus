import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { settings } from "@/config";
import { createServices, type Services, setServices } from "@/services";

export interface CreateTestServicesOptions {
	/** Override the dataDir (defaults to a fresh tmp directory). */
	dataDir?: string;
	/** Override the timezone (defaults to settings.timezone). */
	timezone?: string;
}

/**
 * Build a fresh Services container with an isolated tmp dataDir.
 * Also calls setServices() so module-level store delegators resolve to it.
 * Tests that need state isolation should call this in beforeEach.
 */
export function installTestServices(
	options: CreateTestServicesOptions = {},
): Services {
	const dataDir =
		options.dataDir ?? mkdtempSync(path.join(tmpdir(), "klaus-test-"));
	const timezone = options.timezone ?? settings.timezone;
	const services = createServices({ dataDir, timezone });
	setServices(services);
	return services;
}
