import type { FlagDef } from "./index";

export const voiceFlag: FlagDef = {
	name: "voice",
	aliases: ["v"],
	description: "Reply as a voice message (TTS)",
	overrides: { forceVoice: true },
};
