import { mock } from 'bun:test';

const MOCK_EMBEDDING = new Array(1536).fill(0.01);

mock.module('ai', () => ({
  embed: () => Promise.resolve({ embedding: MOCK_EMBEDDING }),
}));
mock.module('@ai-sdk/openai', () => ({
  openai: Object.assign(() => ({}), { embedding: () => ({}) }),
}));

import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db/client';
import { chunks, nodeVersions, nodes } from '../../db/schema';
import { estimateTokens, upsertNode, writeNode } from '../../db/write';
import { describeDb, setupTestDb } from './helpers';

setupTestDb();

const LONG_BODY = (() => {
  const para = 'word '.repeat(500);
  return `${para}\n\n${para}`;
})();

describeDb('writeNode', () => {
  test('inserts a node and returns the full typed row', async () => {
    const node = await writeNode({ type: 'assertion', title: 'Test title', body: 'Test body' });

    expect(node.id).toBeString();
    expect(node.type).toBe('assertion');
    expect(node.title).toBe('Test title');
    expect(node.body).toBe('Test body');
    expect(node.pinned).toBe(false);
    expect(node.archived).toBe(false);
  });

  test('sets created_at and updated_at automatically', async () => {
    // Allow 1s of clock skew between the macOS host and the Docker container.
    const before = Date.now() - 1000;
    const node = await writeNode({ type: 'assertion', body: 'hi' });
    const after = Date.now() + 1000;

    expect(node.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(node.createdAt.getTime()).toBeLessThanOrEqual(after);
    expect(node.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('generates embedding on insert', async () => {
    const node = await writeNode({ type: 'assertion', body: 'some text' });
    expect(node.embedding).toEqual(MOCK_EMBEDDING);
  });

  test('populates search_tsv on insert', async () => {
    const node = await writeNode({ type: 'assertion', title: 'hello world', body: 'foo bar' });

    const [row] = await db
      .select({ searchTsv: nodes.searchTsv })
      .from(nodes)
      .where(eq(nodes.id, node.id));

    expect(row?.searchTsv).toBeTruthy();
  });

  test('chunks body that exceeds the token threshold', async () => {
    expect(estimateTokens(LONG_BODY)).toBeGreaterThan(config.chunking.thresholdTokens);

    const node = await writeNode({ type: 'document', body: LONG_BODY });

    const chunkRows = await db.select().from(chunks).where(eq(chunks.nodeId, node.id));
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows[0]?.embedding).toEqual(MOCK_EMBEDDING);
    expect(chunkRows[0]?.tokenCount).toBeGreaterThan(0);
  });

  test('does not create chunks for short body', async () => {
    const node = await writeNode({ type: 'assertion', body: 'Short body' });
    const chunkRows = await db.select().from(chunks).where(eq(chunks.nodeId, node.id));
    expect(chunkRows.length).toBe(0);
  });
});

describeDb('upsertNode', () => {
  test('creates a node_version snapshot before updating', async () => {
    const node = await writeNode({ type: 'assertion', title: 'v1', body: 'original' });
    await upsertNode(node.id, { title: 'v2', body: 'updated' }, 'user_edit');

    const versions = await db
      .select()
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, node.id));

    expect(versions.length).toBe(1);
    expect(versions[0]?.title).toBe('v1');
    expect(versions[0]?.body).toBe('original');
  });

  test('increments version counter on each update', async () => {
    const node = await writeNode({ type: 'assertion', body: 'v1' });
    await upsertNode(node.id, { body: 'v2' }, 'user_edit');
    await upsertNode(node.id, { body: 'v3' }, 'reflection');

    const versions = await db
      .select({ version: nodeVersions.version })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, node.id));

    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  test('records the correct reason on the snapshot', async () => {
    const node = await writeNode({ type: 'assertion', body: 'original' });
    await upsertNode(node.id, { body: 'fixed' }, 'contradiction_resolved');

    const [version] = await db
      .select({ reason: nodeVersions.reason })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, node.id));

    expect(version?.reason).toBe('contradiction_resolved');
  });

  test('updates embedding and search_tsv after body change', async () => {
    const node = await writeNode({ type: 'assertion', body: 'original' });
    const updated = await upsertNode(node.id, { body: 'new content here' }, 'user_edit');

    expect(updated.embedding).toEqual(MOCK_EMBEDDING);

    const [row] = await db
      .select({ searchTsv: nodes.searchTsv })
      .from(nodes)
      .where(eq(nodes.id, node.id));

    expect(row?.searchTsv).toBeTruthy();
  });

  test('returns the updated node', async () => {
    const node = await writeNode({ type: 'assertion', title: 'old', body: 'old body' });
    const updated = await upsertNode(node.id, { title: 'new title' }, 'user_edit');

    expect(updated.id).toBe(node.id);
    expect(updated.title).toBe('new title');
    expect(updated.body).toBe('old body');
  });

  test('removes chunks when body shrinks below threshold', async () => {
    const node = await writeNode({ type: 'document', body: LONG_BODY });

    const before = await db.select().from(chunks).where(eq(chunks.nodeId, node.id));
    expect(before.length).toBeGreaterThan(0);

    await upsertNode(node.id, { body: 'Short body now' }, 'user_edit');

    const after = await db.select().from(chunks).where(eq(chunks.nodeId, node.id));
    expect(after.length).toBe(0);
  });

  test('returns an error for unknown node id', async () => {
    let caught: unknown;
    try {
      await upsertNode('00000000-0000-0000-0000-000000000000', { title: 'x' }, 'user_edit');
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain('Node not found');
  });
});
