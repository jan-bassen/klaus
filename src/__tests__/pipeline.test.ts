import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, InboundMessage, TurnContext } from '@/types';

// ─── Mocks (must precede all imports of the modules under test) ───────────────
//
// Only mock modules that have no own test file or that would require live
// infrastructure (DB, LLM). Internal modules with their own test files use real
// implementations to avoid polluting the shared module registry.

// @/whatsapp/send — keep mocked: no own test file, prevents actual sends
const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module('@/whatsapp/send', () => ({ enqueueMessage: mockEnqueueMessage }));

// @/db/client + @/db/write — keep mocked: require live Postgres
const mockReturning = mock(async () => [{ id: 'msg-id-1' }]);
const mockInsert = mock(() => ({ values: () => ({ returning: mockReturning, catch: () => undefined }) }));
mock.module('@/db/client', () => ({
  db: { insert: mockInsert },
}));

const mockUpdateFileMessageId = mock(async () => undefined);
const mockResolveQuotedMessageId = mock(async () => null as string | null);
mock.module('@/db/write', () => ({
  updateFileMessageId: mockUpdateFileMessageId,
  resolveQuotedMessageId: mockResolveQuotedMessageId,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { handleTurn, _setAgentRunnerForTest, _clearAgentRunnerForTest } from '@/core/pipeline';
import { setContextQueries } from '@/core/assemble';
import { _resetForTest, checkMessageRate } from '@/core/rate-limiter';
import { registry } from '@/commands';
import { config } from '@/config';
import { agentRegistry } from '@/core/agent';

// ─── Test seam — captures agent turns without mock.module pollution ──────────

const capturedTurns: TurnContext[] = [];
const mockAgentRunner = mock(async (turn: TurnContext, _def: AgentDefinition) => {
  capturedTurns.push(turn);
});

// ─── Filesystem helpers ───────────────────────────────────────────────────────

const TEST_CHAT_ID = 'user@s.whatsapp.net';
// Agents dir: src/__tests__/ → src/agents/
const AGENTS_DIR = join(import.meta.dir, '..', 'agents');

let tmpDir: string;
let fakeAudioPath: string;
let fakeImagePath: string;
let savedAllowedChatId: string | undefined;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  fakeAudioPath = join(tmpDir, 'audio.ogg');
  // voice.ts calls blob.arrayBuffer() before its try/catch, so a real file must exist
  await writeFile(fakeAudioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // OGG magic
  fakeImagePath = join(tmpDir, 'photo.jpg');
  await writeFile(fakeImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic

  savedAllowedChatId = process.env.ALLOWED_CHAT_ID;

  // Use no context queries so assembleContext always returns { vars: {}, totalTokens: 0 }
  setContextQueries([]);

  // Inject the agent runner test seam
  _setAgentRunnerForTest(mockAgentRunner);
});

afterAll(async () => {
  _clearAgentRunnerForTest();
  await rm(tmpDir, { recursive: true, force: true });
  if (savedAllowedChatId !== undefined) {
    process.env.ALLOWED_CHAT_ID = savedAllowedChatId;
  } else {
    delete process.env.ALLOWED_CHAT_ID;
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const base: InboundMessage = {
    kind: 'whatsapp',
    id: 'msg-1',
    chatId: TEST_CHAT_ID,
    senderId: TEST_CHAT_ID,
    text: 'hello',
    timestamp: new Date(),
    messageKey: {},
  };
  return { ...base, ...overrides };
}

function lastTurn(): TurnContext {
  return capturedTurns.at(-1)!;
}

beforeEach(() => {
  // Allow all messages through auth by default
  process.env.ALLOWED_CHAT_ID = TEST_CHAT_ID;

  // Reset rate limiter state so each test starts fresh
  _resetForTest();

  // Clear the agent registry to prevent cross-test cache pollution
  agentRegistry.clear();

  // Reset captured state
  capturedTurns.length = 0;

  // Reset mocks
  mockAgentRunner.mockClear();
  mockEnqueueMessage.mockClear();
  mockInsert.mockClear();
  mockReturning.mockClear();
  mockUpdateFileMessageId.mockClear();
  mockResolveQuotedMessageId.mockClear();

  mockReturning.mockImplementation(async () => [{ id: 'msg-id-1' }]);
  mockResolveQuotedMessageId.mockImplementation(async () => null);
});

// ─── Auth + rate limiting ─────────────────────────────────────────────────────

describe('handleTurn — guards', () => {
  test('auth rejected: returns without calling runAgent', async () => {
    process.env.ALLOWED_CHAT_ID = 'other@s.whatsapp.net';
    await handleTurn(makeMsg());
    expect(mockAgentRunner).not.toHaveBeenCalled();
  });

  test('rate limited: enqueues rate-limit message and skips runAgent', async () => {
    const msg = makeMsg();
    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msg);
    }
    await handleTurn(msg);
    expect(mockAgentRunner).not.toHaveBeenCalled();
    expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
    const opts = (mockEnqueueMessage.mock.calls as unknown as [{ content: string }][])[0]![0];
    expect(opts.content).toMatch(/too many/i);
  });

  test('command dispatch: calls commandRegistry and skips runAgent', async () => {
    const mockExecute = mock(async () => undefined);
    registry.register({ name: 'test-dispatch', description: 'Test', execute: mockExecute });
    await handleTurn(makeMsg({ text: '/test-dispatch' }));
    expect(mockAgentRunner).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ─── Media normalization — audio ──────────────────────────────────────────────

describe('handleTurn — audio media', () => {
  let savedKey: string | undefined;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedKey = process.env.ELEVENLABS_API_KEY;
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  });

  test('transcribes audio and passes transcript as message text', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: 'hello world' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const msg = makeMsg({ media: { fileId: 'fid-1', path: fakeAudioPath, mimeType: 'audio/ogg' } });
    delete (msg as Partial<InboundMessage>).text;
    await handleTurn(msg);
    expect(lastTurn().message?.text).toBe('hello world');
  });

  test('stores transcript as text and preserves caption in media.voiceCaption', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: 'audio transcript' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await handleTurn(makeMsg({
      text: 'user caption',
      media: { fileId: 'fid-1', path: fakeAudioPath, mimeType: 'audio/ogg' },
    }));
    expect(lastTurn().message?.text).toBe('audio transcript');
    expect(lastTurn().message?.media?.voiceCaption).toBe('user caption');
  });

  test('falls back to original message when transcription fails (no API key)', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await handleTurn(makeMsg({
      text: 'original text',
      media: { fileId: 'fid-1', path: fakeAudioPath, mimeType: 'audio/ogg' },
    }));
    expect(mockAgentRunner).toHaveBeenCalledTimes(1);
    expect(lastTurn().message?.text).toBe('original text');
  });
});

// ─── Media normalization — image / document ───────────────────────────────────

describe('handleTurn — image media', () => {
  test('does not call fetch/transcribe for images (vision handled by agent)', async () => {
    let fetchCalled = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await handleTurn(makeMsg({
      text: 'look at this',
      media: { fileId: 'fid-2', path: '/tmp/photo.jpg', mimeType: 'image/jpeg' },
    }));
    globalThis.fetch = savedFetch;

    expect(fetchCalled).toBe(false);
    expect(mockAgentRunner).toHaveBeenCalledTimes(1);
  });

  test('preserves original text when image has a caption', async () => {
    await handleTurn(makeMsg({
      text: 'caption text',
      media: { fileId: 'fid-2', path: '/tmp/photo.png', mimeType: 'image/png' },
    }));
    expect(lastTurn().message?.text).toBe('caption text');
  });
});

describe('handleTurn — document media', () => {
  test('passes through document without text annotation', async () => {
    const msg = makeMsg({
      media: { fileId: 'fid-3', path: '/tmp/.files/2024-01-01/abc.pdf', mimeType: 'application/pdf' },
    });
    delete (msg as Partial<InboundMessage>).text;
    await handleTurn(msg);
    // Metadata is now exposed via message context query variables, not injected into text
    expect(lastTurn().message?.text || '').toBe('');
    expect(lastTurn().message?.media?.mimeType).toBe('application/pdf');
  });

  test('preserves existing caption for document without annotation', async () => {
    await handleTurn(makeMsg({
      text: 'see attached',
      media: { fileId: 'fid-3', path: '/tmp/.files/2024-01-01/report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    }));
    expect(lastTurn().message?.text).toBe('see attached');
  });
});

// ─── Agent routing ────────────────────────────────────────────────────────────

describe('handleTurn — agent routing', () => {
  test('routes to default agent (Klaus) when no @agent prefix', async () => {
    await handleTurn(makeMsg({ text: 'just a normal message' }));
    expect(mockAgentRunner).toHaveBeenCalledTimes(1);
    expect(lastTurn().agent?.name).toBe('klaus');
  });

  test('@agent prefix routes to the named agent and strips prefix from text', async () => {
    await handleTurn(makeMsg({ text: '@thinking do some research' }));
    expect(lastTurn().agent?.name).toBe('thinking');
    expect(lastTurn().message?.text).toBe('do some research');
  });

  test('uses cached agent from registry without calling loadAgentDefinition', async () => {
    // Pre-populate with a fake name that has no .md file; use a real promptPath.
    // If cache is missed: loadAgentDefinition fails (no __cached__.md) → error → runner skipped.
    // If cache is hit: runner is called with agentName '__cached__'.
    const cachedDef: AgentDefinition = {
      name: '__cached__',
      modelTier: 'default',
      tools: [],
      promptPath: join(AGENTS_DIR, 'thinking.md'),
    };
    agentRegistry.set('__cached__', cachedDef);
    await handleTurn(makeMsg({ text: '@__cached__ run it' }));
    expect(mockAgentRunner).toHaveBeenCalledTimes(1);
    expect(lastTurn().agent?.name).toBe('__cached__');
  });
});

// ─── File messageId backfill ──────────────────────────────────────────────────

describe('handleTurn — file messageId backfill', () => {
  test('calls updateFileMessageId with fileId and inserted messageId', async () => {
    mockReturning.mockImplementation(async () => [{ id: 'db-msg-id' }]);
    await handleTurn(makeMsg({
      media: { fileId: 'file-uuid-abc', path: fakeAudioPath, mimeType: 'audio/ogg' },
    }));
    expect(mockUpdateFileMessageId).toHaveBeenCalledTimes(1);
    const [fileId, messageId] = mockUpdateFileMessageId.mock.calls[0] as unknown as [string, string];
    expect(fileId).toBe('file-uuid-abc');
    expect(messageId).toBe('db-msg-id');
  });

  test('does not call updateFileMessageId when message has no media', async () => {
    const msg = makeMsg({ text: 'plain text' });
    delete (msg as Partial<InboundMessage>).media;
    await handleTurn(msg);
    expect(mockUpdateFileMessageId).not.toHaveBeenCalled();
  });
});

// ─── Quoted message handling ──────────────────────────────────────────────────

describe('handleTurn — quoted messages', () => {
  test('calls resolveQuotedMessageId with chatId and externalId when message is a reply', async () => {
    const msg = makeMsg({
      quotedMessage: { externalId: 'baileys-id-xyz' },
    });
    await handleTurn(msg);
    expect(mockResolveQuotedMessageId).toHaveBeenCalledTimes(1);
    const [chatId, externalId] = mockResolveQuotedMessageId.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe(TEST_CHAT_ID);
    expect(externalId).toBe('baileys-id-xyz');
  });

  test('does not call resolveQuotedMessageId when message has no quote', async () => {
    await handleTurn(makeMsg({ text: 'plain message' }));
    expect(mockResolveQuotedMessageId).not.toHaveBeenCalled();
  });

  test('resolves FK and continues normally even when quoted message is not in DB (returns null)', async () => {
    mockResolveQuotedMessageId.mockImplementation(async () => null);
    const msg = makeMsg({
      quotedMessage: { externalId: 'old-id' },
    });
    await handleTurn(msg);
    expect(mockAgentRunner).toHaveBeenCalledTimes(1);
  });

  test('passes quotedMessage through to the agent turn', async () => {
    const quoted = { externalId: 'id-abc' };
    await handleTurn(makeMsg({ text: 'Yes of course', quotedMessage: quoted }));
    expect(lastTurn().message?.quotedMessage).toEqual(quoted);
  });
});
