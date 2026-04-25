/**
 * Per-turn prompt compilation.
 *
 * Single home for all template rendering: the agent's `.md` body, the
 * `Klaus/templates/` files (`message-user`, `error-message`,
 * `report-short`, `report-full`), and the sampling-config translation.
 *
 * Templates are eager-loaded at startup via `loadTemplates()` so each one
 * doubles as a Handlebars partial others can include via `{{> name}}`. The
 * vault watcher calls `invalidateTemplate(name)` when a `.md` under
 * `Klaus/templates/` changes, so edits show up on the next render without a
 * restart.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
	ChatContentImage,
	ChatContentItems as ChatContentItem,
	ChatContentText,
	ChatUserMessage,
} from "@openrouter/sdk/models";
import { resolveProvider, settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { hbs, interpolateUserVars } from "@/infra/vault/markdown";
import type { TurnContext } from "@/pipeline/agent";
import { prepareImage } from "@/pipeline/media";
import type { TurnConfig } from "./overrides";

/** User-message content as accepted by the chat completions API. */
export type UserContent = ChatUserMessage["content"];

// ── Template loader ────────────────────────────────────────────────────────

export type TemplateName =
	| "message-user"
	| "error-message"
	| "report-short"
	| "report-full";

const _compiled = new Map<string, HandlebarsTemplateDelegate>();

function templatePath(name: string): string {
	return path.join(settings.vault.templatesDir, `${name}.md`);
}

/**
 * Read + compile + register the template under `name`. Used both at startup
 * and on hot-reload. Every template doubles as a Handlebars partial under its
 * name, so templates can include each other (`{{> message-tool}}`).
 *
 * Returns the compiled function on success; on failure logs and removes the
 * cache + partial so a missing file surfaces at the next render.
 */
function registerTemplate(name: string): HandlebarsTemplateDelegate | null {
	const fp = templatePath(name);
	let raw: string;
	try {
		raw = readFileSync(fp, "utf-8");
	} catch {
		_compiled.delete(name);
		hbs.unregisterPartial(name);
		return null;
	}

	const compiled = hbs.compile(raw, { noEscape: true });
	_compiled.set(name, compiled);
	hbs.registerPartial(name, compiled);
	return compiled;
}

/**
 * Eager-load every `.md` in `Klaus/templates/` at startup so partials are
 * available before the first render. Idempotent — safe to call again after
 * the templates dir is created.
 */
export function loadTemplates(): void {
	const dir = settings.vault.templatesDir;
	if (!existsSync(dir)) {
		log.warn(`[prompts] templates dir missing: ${dir}`);
		return;
	}
	let count = 0;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const name = file.replace(/\.md$/, "");
		if (registerTemplate(name)) count++;
	}
	log.info(`[prompts] loaded ${count} templates`);
}

/**
 * Render a template with the given variables and tidy collapsed blank lines.
 * Cold-loads the file on first use if `loadTemplates()` wasn't called yet.
 */
export function renderTemplate(
	name: TemplateName,
	vars: Record<string, unknown>,
): string {
	const cached = _compiled.get(name);
	const compiled = cached ?? registerTemplate(name);
	if (!compiled) {
		throw new Error(
			`Missing template at ${templatePath(name)}. Create it under Klaus/templates/ to format ${name} content.`,
		);
	}
	return compiled(vars)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Re-load a template (and its partial) from disk. Called by the vault
 * watcher when a `Klaus/templates/*.md` file changes. Unknown names that
 * don't resolve to a file silently drop themselves from the registry.
 */
export function invalidateTemplate(name: string): void {
	registerTemplate(name);
}

// ── System prompt ──────────────────────────────────────────────────────────

/** Compile an agent prompt body with the unified variable namespace. */
export function buildSystemPrompt(
	body: string,
	vars: Record<string, unknown>,
): string {
	const template = hbs.compile(body, { noEscape: true });
	return template(vars)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ── User message ───────────────────────────────────────────────────────────

/**
 * Render the user-turn text via `message-user.md`. Throws if the template
 * is missing — setup should be explicit, not silently fall back to raw text.
 */
function renderUserText(turn: TurnContext): string {
	if (!turn.message) return "";

	const messageText = turn.message.media?.mimeType.startsWith("audio/")
		? (turn.message.media?.transcription ?? "")
		: (turn.message.text ?? "");

	const rendered = renderTemplate("message-user", {
		...turn.vars,
		quotedText: turn.message.quotedMessage?.text ?? "",
		messageText,
		overrides: Object.keys(turn.overrides),
	});

	return interpolateUserVars(rendered, turn.vars);
}

/**
 * Assemble the model's user-turn content:
 *   - dispatch-only turns       → the dispatch objective
 *   - vision turns (img or quoted img) → [image, text] parts
 *   - everything else           → rendered template text
 */
export async function buildUserMessage(
	turn: TurnContext,
): Promise<UserContent> {
	const inboundMedia = turn.message?.media;
	const quotedMedia = turn.message?.quotedMessage?.media;
	const visionMedia = inboundMedia?.mimeType.startsWith("image/")
		? inboundMedia
		: quotedMedia?.mimeType.startsWith("image/")
			? quotedMedia
			: null;

	if (visionMedia) {
		const text = renderUserText(turn);
		const resized = await prepareImage(visionMedia.path);
		const imagePart: ChatContentImage = {
			type: "image_url",
			imageUrl: {
				url: `data:${visionMedia.mimeType};base64,${resized.toString("base64")}`,
			},
		};
		const parts: ChatContentItem[] = text
			? [imagePart, { type: "text", text } as ChatContentText]
			: [imagePart];
		return parts;
	}

	if (turn.message) return renderUserText(turn);

	return turn.dispatchContext?.prompt ?? "";
}

// ── Sampling resolution ────────────────────────────────────────────────────

export interface ResolvedSampling {
	temperature?: number;
	topP?: number;
	reasoning?: { effort: "low" | "high" };
}

/**
 * Translate `TurnConfig` sampling/reasoning overrides into concrete model-call
 * parameters. Temperature/topP resolve against the configured provider's preset
 * numbers; reasoning effort maps to OpenAI-shape `reasoning.effort`.
 */
export function resolveSampling(config: TurnConfig): ResolvedSampling {
	const { config: providerCfg } = resolveProvider();
	const out: ResolvedSampling = {};

	const tempPreset = config.temperaturePreset;
	if (tempPreset === "cold") {
		out.temperature = providerCfg.coldTemperature ?? 0;
	} else if (tempPreset === "hot") {
		out.temperature = providerCfg.hotTemperature ?? 1;
	} else if (providerCfg.temperature !== undefined) {
		out.temperature = providerCfg.temperature;
	}

	const topPPreset = config.topPPreset;
	if (topPPreset === "creative") {
		out.topP = providerCfg.creativeTopP ?? 0.95;
	} else if (topPPreset === "rigid") {
		out.topP = providerCfg.rigidTopP ?? 0.1;
	} else if (providerCfg.topP !== undefined) {
		out.topP = providerCfg.topP;
	}

	if (config.reasoningEffort) {
		out.reasoning = { effort: config.reasoningEffort };
	}

	return out;
}
