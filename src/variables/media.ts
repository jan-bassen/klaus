import type { Variable } from "@/variables";

interface DocMedia {
	text: string;
	name: string;
	mime: string;
}
interface ImageMedia {
	name: string;
	mime: string;
}
interface VoiceMedia {
	caption: string;
	transcript: string;
}

export interface MediaNamespace {
	kind: "doc" | "image" | "voice" | null;
	doc: DocMedia | null;
	image: ImageMedia | null;
	voice: VoiceMedia | null;
	/** Quoted-message media, if this is a reply to a message with media. */
	quoted: { mime: string } | null;
}

/** Attached media (document, image, voice) for the current turn, if any. */
export const mediaVariable: Variable = {
	key: "media",
	description: "Document, image, or voice attached to the current message",
	async run(turn) {
		const m = turn.message?.media;
		const quoted = turn.message?.quotedMessage?.media;
		const out: MediaNamespace = {
			kind: null,
			doc: null,
			image: null,
			voice: null,
			quoted: quoted ? { mime: quoted.mimeType } : null,
		};

		if (!m) return out;

		if (m.mimeType.startsWith("audio/")) {
			out.kind = "voice";
			out.voice = {
				caption: m.voiceCaption ?? "",
				transcript: m.transcription ?? "",
			};
		} else if (m.mimeType.startsWith("image/")) {
			out.kind = "image";
			out.image = { name: m.fileName ?? "", mime: m.mimeType };
		} else {
			out.kind = "doc";
			out.doc = {
				text: m.extractedText ?? "",
				name: m.fileName ?? "",
				mime: m.mimeType,
			};
		}

		return out;
	},
};
