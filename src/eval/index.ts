import path from "node:path";
import { loadAgents } from "@/agent";
import { loadSettingsFromDisk, settings } from "@/config";
import { loadOverrides } from "@/pipeline/overrides";
import { loadSkills } from "@/tools/skill";
import { loadVariables, setVariables } from "@/variables";
import { type EvalResult, runEvalFile } from "./runner";

// ─── ANSI colors ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function tag(passed: boolean): string {
	return passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printResults(results: EvalResult[]): boolean {
	let allPassed = true;

	for (const result of results) {
		const total = result.cases.length;
		console.log(
			`\n${BOLD}Eval: ${result.agent}${RESET} (${total} case${total !== 1 ? "s" : ""}, ${DIM}${result.model}${RESET})`,
		);
		console.log("─".repeat(50));

		let casesPass = 0;
		let criteriaPass = 0;
		let criteriaTotal = 0;
		let tokenPrompt = 0;
		let tokenCompletion = 0;
		let totalMs = 0;

		for (const c of result.cases) {
			const sec = (c.durationMs / 1000).toFixed(1);
			tokenPrompt += c.tokens.prompt;
			tokenCompletion += c.tokens.completion;
			totalMs += c.durationMs;

			if (c.error) {
				console.log(
					` ${YELLOW}ERR${RESET}   ${c.name.padEnd(30)} ${DIM}${sec}s${RESET}`,
				);
				console.log(`       ${DIM}${c.error}${RESET}`);
				allPassed = false;
				continue;
			}

			criteriaTotal += c.judgments.length;
			const casePass = c.judgments.filter((j) => j.pass).length;
			criteriaPass += casePass;

			if (c.passed) {
				casesPass++;
				console.log(
					` ${tag(true)}  ${c.name.padEnd(30)} ${DIM}${sec}s${RESET}`,
				);
			} else {
				allPassed = false;
				console.log(
					` ${tag(false)}  ${c.name.padEnd(30)} ${DIM}${sec}s${RESET}`,
				);
				for (const j of c.judgments) {
					if (!j.pass) {
						console.log(`       ${RED}FAIL${RESET}  ${j.criterion}`);
						console.log(`             ${DIM}${j.reason}${RESET}`);
					}
				}
			}
		}

		console.log("─".repeat(50));
		console.log(
			`Results: ${casesPass}/${total} passed | ${criteriaPass}/${criteriaTotal} criteria passed`,
		);
		console.log(
			`Tokens: ${tokenPrompt.toLocaleString()} in + ${tokenCompletion.toLocaleString()} out | ${(totalMs / 1000).toFixed(1)}s total`,
		);
	}

	return allPassed;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const agentFilter = args[0];
	const caseFilter = args[1];

	// Minimal bootstrap — no WhatsApp, no server, no queue
	await loadSettingsFromDisk();
	await loadAgents(settings.vault.agentsDir);
	const variables = await loadVariables(
		path.join(import.meta.dir, "..", "variables"),
	);
	setVariables(variables);
	await loadOverrides();
	await loadSkills(settings.vault.skillsDir);

	// Discover eval files
	const evalsDir = path.join(settings.vault.internalPath, "evals");
	const glob = new Bun.Glob("*.yml");
	const files: string[] = [];
	for await (const file of glob.scan({ cwd: evalsDir })) {
		const name = file.replace(/\.yml$/, "");
		if (agentFilter && name !== agentFilter) continue;
		files.push(path.join(evalsDir, file));
	}

	if (files.length === 0) {
		const msg = agentFilter
			? `No eval file found for agent: ${agentFilter}`
			: `No eval files found in ${evalsDir}`;
		console.error(msg);
		process.exit(1);
	}

	// Run evals sequentially
	const results: EvalResult[] = [];
	for (const file of files) {
		const result = await runEvalFile(file, caseFilter);
		results.push(result);
	}

	const allPassed = printResults(results);
	process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
	console.error(
		"Eval failed:",
		err instanceof Error ? err.message : String(err),
	);
	process.exit(1);
});
