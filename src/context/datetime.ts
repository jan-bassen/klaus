import type { ContextQuery } from "@/types";
import { config } from "@/config";

// Rough token estimate: 1 token ≈ 4 characters (good enough for short strings).
const CHARS_PER_TOKEN = 4;

export const dateQuery: ContextQuery = {
  name: "date",
  priority: -1,
  run: async () => {
    const content = new Date().toLocaleDateString(config.locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: config.timezone,
    });
    return {
      content,
      tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      truncate: "never",
    };
  },
};

export const timeQuery: ContextQuery = {
  name: "time",
  priority: -1,
  run: async () => {
    const content = new Date().toLocaleTimeString(config.locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: config.timezone,
    });
    return {
      content,
      tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      truncate: "never",
    };
  },
};

export const weekdayQuery: ContextQuery = {
  name: "weekday",
  priority: -1,
  run: async () => {
    const content = new Date().toLocaleDateString(config.locale, {
      weekday: "long",
      timeZone: config.timezone,
    });
    return {
      content,
      tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      truncate: "never",
    };
  },
};
