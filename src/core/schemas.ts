import { z } from "zod";

export const AgentFrontmatterSchema = z.object({
	name: z.string().min(1),
	modelTier: z.enum(["default", "low", "high"]),
	tools: z.array(z.string()).default([]),
	toolsets: z.array(z.string()).default([]),
	providerTools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	schedule: z.string().optional(),
	vaultScope: z.string().optional(),
	context: z.record(z.record(z.unknown())).optional(),
});
