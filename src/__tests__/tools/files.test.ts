import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── DB / write / config mocks (must be set up before importing files/index.ts) ──

// tmpDir is declared here so the config mock getter can close over it.
// beforeAll populates it before any test runs.
let tmpDir: string;

// Mutable state — individual tests configure this before calling a tool
let _dbRows: Record<string, unknown>[] = [];

const mockDeleteWhere = mock(async () => undefined);

const mockSaveFile = mock(
  async (): Promise<{ id: string; path: string } | Error> => ({
    id: 'file-uuid-123',
    path: '/tmp/.files/2024-01-01/file-uuid-123.txt',
  }),
);

// Chainable select builder: both `.from()` and `.from().where()` are awaitable
function makeSelectChain() {
  const chain: {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (rej: (e: unknown) => unknown) => Promise<unknown>;
    where: (_cond: unknown) => Promise<unknown>;
  } = {
    then: (res, rej) => Promise.resolve(_dbRows).then(res, rej),
    catch: (rej) => Promise.resolve(_dbRows).catch(rej),
    where: (_cond) => Promise.resolve(_dbRows),
  };
  return chain;
}

mock.module('@/db/client', () => ({
  db: {
    select: () => ({ from: () => makeSelectChain() }),
    delete: () => ({ where: mockDeleteWhere }),
  },
}));

mock.module('@/db/write', () => ({ saveFile: mockSaveFile }));

// ─── import after mocks are registered ───────────────────────────────────────

import { filesDeleteTool, filesDownloadTool, filesListTool, filesUploadTool } from '@/tools/files';
import type { AssembledContext, TurnContext } from '@/types';

// ─── test fixtures ────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'files-test-'));
  process.env.FILES_DIR = tmpDir;
});

afterAll(async () => {
  delete process.env.FILES_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

const dummyContext = {
  chatId: 'user@s.whatsapp.net',
  agent: { name: 'test', modelTier: 'default' as const, tools: [], promptPath: '/dev/null' },
  flags: {},
  assembled: { vars: {}, totalTokens: 0 } as AssembledContext,
} as TurnContext;

function makeFileRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'file-uuid-123',
    path: join(tmpDir, 'file-uuid-123.txt'),
    mimeType: 'text/plain',
    sizeBytes: 13,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    messageId: null,
    nodeId: null,
    ...overrides,
  };
}

beforeEach(() => {
  _dbRows = [];
  mockDeleteWhere.mockClear();
  mockSaveFile.mockClear();
  mockSaveFile.mockImplementation(async () => ({
    id: 'file-uuid-123',
    path: join(tmpDir, 'file-uuid-123.txt'),
  }));
});

// ─── filesUploadTool ─────────────────────────────────────────────────────────

describe('filesUploadTool', () => {
  test('decodes base64, writes to disk, and returns success string with fileId', async () => {
    const content = Buffer.from('hello world').toString('base64');
    const result = await filesUploadTool.execute(
      { name: 'test.txt', content, mimeType: 'text/plain' },
      dummyContext,
    );
    expect(mockSaveFile).toHaveBeenCalledTimes(1);
    expect(result).toContain('file-uuid-123');
    expect(result).toContain('test.txt');
  });

  test('returns "Upload failed" string when saveFile returns an Error', async () => {
    mockSaveFile.mockImplementation(async () => new Error('DB constraint violation'));
    const content = Buffer.from('data').toString('base64');
    const result = await filesUploadTool.execute(
      { name: 'fail.txt', content, mimeType: 'text/plain' },
      dummyContext,
    );
    expect(result).toMatch(/Upload failed.*DB constraint/);
  });

  test('passes nodeId to saveFile when provided', async () => {
    const content = Buffer.from('x').toString('base64');
    const nodeId = crypto.randomUUID();
    await filesUploadTool.execute(
      { name: 'linked.txt', content, mimeType: 'text/plain', nodeId },
      dummyContext,
    );
    const [callArg] = mockSaveFile.mock.calls[0] as unknown as [{ nodeId?: string }];
    expect(callArg.nodeId).toBe(nodeId);
  });
});

// ─── filesDownloadTool ───────────────────────────────────────────────────────

describe('filesDownloadTool', () => {
  let testFilePath: string;

  beforeAll(async () => {
    // Create a real file that download tests can read
    testFilePath = join(tmpDir, 'download-test.txt');
    await writeFile(testFilePath, 'file contents');
  });

  test('returns base64-encoded content when file found by UUID', async () => {
    _dbRows = [makeFileRow({ path: testFilePath })];
    const result = await filesDownloadTool.execute(
      { name: 'file-uuid-123' },
      dummyContext,
    );
    expect(typeof result).toBe('object');
    const r = result as { fileId: string; mimeType: string; content: string };
    expect(r.fileId).toBe('file-uuid-123');
    expect(r.mimeType).toBe('text/plain');
    expect(Buffer.from(r.content, 'base64').toString()).toBe('file contents');
  });

  test('returns "No file found" when DB returns empty array', async () => {
    _dbRows = [];
    const result = await filesDownloadTool.execute({ name: 'missing-uuid' }, dummyContext);
    expect(result).toContain('No file found');
  });

  test('returns error string when file cannot be read from disk', async () => {
    _dbRows = [makeFileRow({ path: '/nonexistent/path/file.txt' })];
    const result = await filesDownloadTool.execute({ name: 'file-uuid-123' }, dummyContext);
    expect(result).toContain('Failed to read file');
  });

  test('uses LIKE path when input is not a UUID', async () => {
    _dbRows = [makeFileRow({ path: testFilePath })];
    const result = await filesDownloadTool.execute({ name: 'download-test' }, dummyContext);
    expect(typeof result).toBe('object');
    expect((result as { fileId: string }).fileId).toBe('file-uuid-123');
  });
});

// ─── filesListTool ───────────────────────────────────────────────────────────

describe('filesListTool', () => {
  test('returns "No files found." when DB returns empty array', async () => {
    _dbRows = [];
    const result = await filesListTool.execute({}, dummyContext);
    expect(result).toBe('No files found.');
  });

  test('formats each row as id | basename | mimeType | size | createdAt', async () => {
    _dbRows = [makeFileRow()];
    const result = await filesListTool.execute({}, dummyContext) as string;
    expect(result).toContain('file-uuid-123');
    expect(result).toContain('text/plain');
    expect(result).toContain('13B');
  });

  test('lists multiple rows, one per line', async () => {
    _dbRows = [makeFileRow({ id: 'aaa' }), makeFileRow({ id: 'bbb' })];
    const result = await filesListTool.execute({}, dummyContext) as string;
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
  });
});

// ─── filesDeleteTool ─────────────────────────────────────────────────────────

describe('filesDeleteTool', () => {
  test('returns "No file found" when DB returns empty array', async () => {
    _dbRows = [];
    const result = await filesDeleteTool.execute({ name: 'missing' }, dummyContext);
    expect(result).toContain('No file found');
  });

  test('calls db.delete and returns success string', async () => {
    // Use a real file so unlink succeeds
    const toDelete = join(tmpDir, 'to-delete.bin');
    await writeFile(toDelete, 'bye');
    _dbRows = [makeFileRow({ path: toDelete })];

    const result = await filesDeleteTool.execute({ name: 'file-uuid-123' }, dummyContext);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(result).toContain('Deleted');
    expect(result).toContain('file-uuid-123');
  });

  test('still deletes the DB row even when the file does not exist on disk', async () => {
    // Path that never existed — unlink will throw ENOENT, code must continue
    _dbRows = [makeFileRow({ path: '/nonexistent/ghost-file.txt' })];

    const result = await filesDeleteTool.execute({ name: 'file-uuid-123' }, dummyContext);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(result).toContain('Deleted');
  });
});
