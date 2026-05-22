/**
 * Per-turn template compilation.
 *
 * Single home for all template rendering: the agent's `.md` body, the
 * `Klaus/templates/` files (`message-user`, `error`, `report`), and
 * the sampling-config translation.
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
import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { hbs, interpolateUserVars } from "../infra/vault/markdown.ts";
import type { TurnContext } from "./core.ts";
import { prepareImage } from "./media.ts";
import type { TurnConfig } from "./overrides.ts";

/** User-message content as accepted by the chat completions API. */
export type UserContent = ChatUserMessage["content"];
const IMAGE_TEXT = "Image";

// ── Template loader ────────────────────────────────────────────────────────

type TemplateName =
	| "history-agent"
	| "history-user"
	| "message-agent"
	| "message-user"
	| "error"
	| "report"
	| "persistence"
	| "welcome"
	| "help";

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
		log.warn(`[templates] templates dir missing: ${dir}`);
		return;
	}
	let count = 0;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const name = file.replace(/\.md$/, "");
		if (registerTemplate(name)) count++;
	}
	log.info(`[templates] loaded ${count} templates`);
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

/** Compile an agent # Message body with the unified variable namespace. */
export function buildAgentMessage(
	body: string,
	vars: Record<string, unknown>,
): string {
	const template = hbs.compile(body, { noEscape: true });
	return interpolateUserVars(
		template(vars)
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		vars,
	);
}

// ── User message ───────────────────────────────────────────────────────────

/**
 * Render the user-turn text via `message-user.md`. Throws if the template
 * is missing — setup should be explicit, not silently fall back to raw text.
 */
function renderUserText(turn: TurnContext): string {
	if (!turn.message) return "";

	const media = turn.message.media;
	const messageText = media?.mimeType.startsWith("audio/")
		? (media.transcription ?? "")
		: (turn.message.text ?? "");

	const isVoice = media?.mimeType.startsWith("audio/") ?? false;
	const isImage = media?.mimeType.startsWith("image/") ?? false;
	const isDocument = !!media && !isVoice && !isImage;

	const rendered = renderTemplate("message-user", {
		...turn.vars,
		messageText,
		isVoice,
		isImage,
		isDocument,
		...(media ? { fileName: media.fileName ?? path.basename(media.path) } : {}),
		...(media?.mimeType ? { mimeType: media.mimeType } : {}),
		...(isDocument && media?.extractedText
			? { extractedText: media.extractedText }
			: {}),
		...(isVoice && media?.voiceCaption
			? { voiceCaption: media.voiceCaption }
			: {}),
		...(turn.message.quotedMessage?.text
			? { quotedText: turn.message.quotedMessage.text, quotedRole: "user" }
			: {}),
		overrides: Object.keys(turn.overrides),
	});

	return interpolateUserVars(rendered, turn.vars);
}

/**
 * Assemble the model's user-turn content:
 *   - dispatch/timer turns      → the agent's # Message template or dispatch objective
 *   - frontmatter schedules     → the agent's # Message template
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

	if (turn.dispatchContext) {
		if (turn.agent.prompt.message) {
			return buildAgentMessage(turn.agent.prompt.message, turn.vars);
		}
		return turn.dispatchContext.prompt;
	}

	if (turn.schedule && turn.agent.prompt.message) {
		return buildAgentMessage(turn.agent.prompt.message, turn.vars);
	}

	return "";
}

export function textOnlyUserContent(content: UserContent): string {
	if (typeof content === "string") return content;

	const text = content
		.map((part) => {
			if (part.type === "text") return part.text;
			return "";
		})
		.join("\n")
		.trim();
	if (text) return text;

	const hasImage = content.some((part) => part.type === "image_url");
	if (hasImage) return IMAGE_TEXT;

	return content
		.map((part) => `[${part.type} omitted from text-only follow-up/report]`)
		.join("\n")
		.trim();
}

// ── Sampling resolution ────────────────────────────────────────────────────

interface ResolvedSampling {
	temperature?: number;
	topP?: number;
	reasoning?: { effort: "low" | "high" };
}

/**
 * Translate `TurnConfig` sampling/reasoning overrides into concrete model-call
 * parameters. Temperature/topP resolve against the global `sampling` presets
 * (normalized 0–1 space — the runtime multiplies by the provider's `tempScale`
 * before sending). Reasoning effort maps to OpenAI-shape `reasoning.effort`.
 */
export function resolveSampling(config: TurnConfig): ResolvedSampling {
	const s = settings.sampling;
	const out: ResolvedSampling = {};

	const tempPreset = config.temperaturePreset;
	if (tempPreset === "cold") {
		out.temperature = s.coldTemperature ?? 0;
	} else if (tempPreset === "hot") {
		out.temperature = s.hotTemperature ?? 1;
	} else if (s.temperature !== undefined) {
		out.temperature = s.temperature;
	}

	const topPPreset = config.topPPreset;
	if (topPPreset === "creative") {
		out.topP = s.creativeTopP ?? 0.95;
	} else if (topPPreset === "rigid") {
		out.topP = s.rigidTopP ?? 0.1;
	} else if (s.topP !== undefined) {
		out.topP = s.topP;
	}

	if (config.reasoningEffort) {
		out.reasoning = { effort: config.reasoningEffort };
	}

	return out;
}
