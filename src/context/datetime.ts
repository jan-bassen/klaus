import type { ContextQuery } from '@/types';

export const dateQuery: ContextQuery = {
  name: 'date',
  priority: -1,
  run: async () => {
    const content = new Date().toLocaleDateString('de-DE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return { content, tokenCount: Math.ceil(content.length / 4), truncate: 'never' };
  },
};

export const timeQuery: ContextQuery = {
  name: 'time',
  priority: -1,
  run: async () => {
    const content = new Date().toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: 'UTC',
    });
    return { content, tokenCount: Math.ceil(content.length / 4), truncate: 'never' };
  },
};
