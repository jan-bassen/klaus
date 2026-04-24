/**
 * Global test setup.
 *
 * 1. Preloads `@/infra/config` before anything else — there's a circular import
 *    between config and the logger that crashes at load time if the logger
 *    module evaluates first. Importing config eagerly here pins the order for
 *    every test file.
 *
 * 2. Per-test cleanup of in-memory registries that survive between suites.
 */

// Critical: must be the very first import.
import "@/infra/config";

import { afterEach } from "vitest";
import { agentRegistry } from "@/pipeline/agents";
import { overrideRegistry } from "@/pipeline/overrides";
import { toolRegistry, toolsetRegistry } from "@/primitives/tools";
import { skillRegistry } from "@/primitives/tools/skill";

afterEach(() => {
	agentRegistry.clear();
	overrideRegistry.clear();
	toolRegistry.clear();
	toolsetRegistry.clear();
	skillRegistry.clear();
});
