/**
 * Global test setup.
 *
 * 1. Preloads `src/infra/config.ts` before anything else — there's a circular import
 *    between config and the logger that crashes at load time if the logger
 *    module evaluates first.
 *
 * 2. Per-test cleanup of in-memory registries that survive between suites.
 */

import { settings } from "../src/infra/config.ts";

import { afterEach } from "vitest";
import { agentRegistry } from "../src/pipeline/agents.ts";
import { overrideRegistry } from "../src/pipeline/overrides.ts";
import {
	toolRegistry,
	toolsetRegistry,
} from "../src/primitives/tools/index.ts";
import { skillRegistry } from "../src/primitives/tools/skill.ts";

settings.reports.vaultMarkdown = false;

afterEach(() => {
	agentRegistry.clear();
	overrideRegistry.clear();
	toolRegistry.clear();
	toolsetRegistry.clear();
	skillRegistry.clear();
});
