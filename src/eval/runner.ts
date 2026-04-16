import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { agentRegistry } from "@/agent";
import { callModel } from "@/agent/model";
import { type ModelTier, modelTiers, settings } from "@/config";
import { hbs, readPromptBody } from "@/markdown";
import type { InboundMessage, TurnContext } from "@/types";
import { assembleVariables } from "@/variables";
import { type Judgment, judge } from "./judge";

// ─── Schemas ────────────────────────────────────────────────────────────────

const EvalCaseSchema = z.object({
	name: z.string().min(1),
	input: z.string().min(1),
	criteria: z.array(z.string().min(1)).min(1),
	vars: z.record(z.unknown()).optional(),
});

const EvalFileSchema = z.object({
	modelTier: z.enum(modelTiers).optional(),
	provider: z.string().optional(),
	cases: z.array(EvalCaseSchema).min(1),
});

type EvalCase = z.infer<typeof EvalCaseSchema>;

// ─── Result types ───────────────────────────────────────────────────────────

export interface CaseResult {
	name: string;
	input: string;
	response: string;
	judgments: Judgment[];
	passed: boolean;
	error?: string;
	durationMs: number;
	tokens: { prompt: number; completion: number };
}

export interface EvalResult {
	agent: string;
	model: string;
	cases: CaseResult[];
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function runEvalFile(
	filePath: string,
	caseFilter?: string,
): Promise<EvalResult> {
	const agentName = path.basename(filePath, ".yml");
	const def = agentRegistry.get(agentName);
	if (!def) throw new Error(`Agent not found in registry: ${agentName}`);

	const raw = await Bun.file(filePath).text();
	const file = EvalFileSchema.parse(parseYaml(raw));

	const cases = caseFilter
		? file.cases.filter((c) => c.name === caseFilter)
		: file.cases;
	if (cases.length === 0) {
		throw new Error(
			caseFilter
				? `Case "${caseFilter}" not found in ${path.basename(filePath)}`
				: `No cases in ${path.basename(filePath)}`,
		);
	}

	const tier: ModelTier = file.modelTier ?? def.modelTier;
	const providerCfg = settings.providers[
		file.provider ?? settings.providers.active
	] as { sdk: string; [k: string]: unknown } | undefined;
	const modelId = providerCfg ? String(providerCfg[tier]) : "unknown";

	const body = await readPromptBody(def.promptPath);

	const results: CaseResult[] = [];

	for (const evalCase of cases) {
		const result = await runCase(evalCase, def, body, tier, file.provider);
		results.push(result);
	}

	return { agent: agentName, model: modelId, cases: results };
}

async function runCase(
	evalCase: EvalCase,
	def: typeof agentRegistry extends Map<string, infer V> ? V : never,
	promptBody: string,
	tier: ModelTier,
	provider: string | undefined,
): Promise<CaseResult> {
	const start = Date.now();
	let totalPrompt = 0;
	let totalCompletion = 0;

	try {
		// Build synthetic turn for variable assembly
		const strippedDef = {
			...def,
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
		};

		const message: InboundMessage = {
			kind: "whatsapp",
			id: `eval-${evalCase.name}`,
			chatId: "eval",
			senderId: "eval",
			text: evalCase.input,
			timestamp: new Date(),
			messageKey: {},
		};

		const syntheticTurn: Omit<TurnContext, "vars"> = {
			chatId: "eval",
			message,
			agent: strippedDef,
			overrides: {},
			config: { skipHistory: true, ghost: true },
			messageRefs: {},
		};

		// Assemble real variables, then deep-merge case overrides
		const vars = await assembleVariables(syntheticTurn);
		if (evalCase.vars) {
			deepMerge(vars, evalCase.vars);
		}

		// Compile system prompt
		const systemPrompt = hbs
			.compile(promptBody, { noEscape: true })(vars)
			.replace(/\n{3,}/g, "\n\n")
			.trim();

		// Call the agent model
		const agentResult = await callModel({
			tier,
			provider,
			system: systemPrompt,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: evalCase.input }],
				},
			],
			temperature: 0,
		});

		totalPrompt += agentResult.usage.promptTokens;
		totalCompletion += agentResult.usage.completionTokens;

		// Judge the response
		const judgeResult = await judge({
			systemPrompt,
			userMessage: evalCase.input,
			response: agentResult.content,
			criteria: evalCase.criteria,
		});

		if (!judgeResult.ok) {
			return {
				name: evalCase.name,
				input: evalCase.input,
				response: agentResult.content,
				judgments: [],
				passed: false,
				error: `Judge returned unparseable output: ${judgeResult.raw.slice(0, 200)}`,
				durationMs: Date.now() - start,
				tokens: { prompt: totalPrompt, completion: totalCompletion },
			};
		}

		const passed = judgeResult.judgments.every((j) => j.pass);

		return {
			name: evalCase.name,
			input: evalCase.input,
			response: agentResult.content,
			judgments: judgeResult.judgments,
			passed,
			durationMs: Date.now() - start,
			tokens: { prompt: totalPrompt, completion: totalCompletion },
		};
	} catch (err) {
		return {
			name: evalCase.name,
			input: evalCase.input,
			response: "",
			judgments: [],
			passed: false,
			error: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
			tokens: { prompt: totalPrompt, completion: totalCompletion },
		};
	}
}

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const key of Object.keys(source)) {
		const tv = target[key];
		const sv = source[key];
		if (
			tv &&
			sv &&
			typeof tv === "object" &&
			!Array.isArray(tv) &&
			typeof sv === "object" &&
			!Array.isArray(sv)
		) {
			deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
		} else {
			target[key] = sv;
		}
	}
}
