import { mock } from 'bun:test';

const MOCK_EMBEDDING = new Array(1536).fill(0.01);

mock.module('ai', () => ({
  embed: () => Promise.resolve({ embedding: MOCK_EMBEDDING }),
}));
mock.module('@ai-sdk/openai', () => ({
  openai: Object.assign(() => ({}), { embedding: () => ({}) }),
}));

import { expect, test } from 'bun:test';
import { db } from '../../db/client';
import { edges } from '../../db/schema';
import { hybridSearch } from '../../db/search';
import { writeNode } from '../../db/write';
import { describeDb, setupTestDb } from './helpers';

setupTestDb();

describeDb('hybridSearch', () => {
  test('returns an empty array when no nodes exist', async () => {
    const results = await hybridSearch({ query: 'anything', embedding: MOCK_EMBEDDING });
    expect(results).toEqual([]);
  });

  test('matches nodes by full-text query', async () => {
    const target = await writeNode({
      type: 'assertion',
      title: 'PostgreSQL internals',
      body: 'Postgres uses MVCC for concurrency control',
    });
    await writeNode({ type: 'assertion', body: 'JavaScript is a scripting language' });

    const results = await hybridSearch({ query: 'postgres concurrency', embedding: MOCK_EMBEDDING });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.node.id).toBe(target.id);
  });

  test('respects the limit option', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        writeNode({ type: 'assertion', body: `test item number ${i + 1}` }),
      ),
    );

    const results = await hybridSearch({ query: 'test item', embedding: MOCK_EMBEDDING, limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test('filters by tags when provided', async () => {
    const tagged = await writeNode({
      type: 'assertion',
      body: 'content with the right label',
      tags: ['postgres', 'db'],
    });
    await writeNode({
      type: 'assertion',
      body: 'content with a different label',
      tags: ['javascript'],
    });

    const results = await hybridSearch({
      query: 'content label',
      embedding: MOCK_EMBEDDING,
      tags: ['postgres'],
    });

    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(tagged.id);
    expect(ids).not.toContain((await writeNode({ type: 'assertion', body: 'js' })).id);
  });

  test('resolves chunk hits back to their parent node', async () => {
    // Create a node whose body gets chunked; unique term lives in the second chunk
    const para = 'filler '.repeat(500);
    const uniqueTerm = 'xylophonequartz'; // guaranteed not to appear elsewhere
    const body = `${para}\n\n${para} ${uniqueTerm}`;

    const parent = await writeNode({ type: 'document', body });

    const results = await hybridSearch({ query: uniqueTerm, embedding: MOCK_EMBEDDING });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.node.id).toBe(parent.id);
  });

  test('surfaces the matching chunk body in the result', async () => {
    const para = 'filler '.repeat(500);
    const uniqueTerm = 'crystallographyzenith';
    const body = `${para}\n\n${para} ${uniqueTerm}`;

    await writeNode({ type: 'document', body });

    const results = await hybridSearch({ query: uniqueTerm, embedding: MOCK_EMBEDDING });

    expect(results[0]?.matchingChunk).toContain(uniqueTerm);
  });

  test('expands related nodes via edges when expandEdges is true', async () => {
    const nodeA = await writeNode({ type: 'topic', title: 'database systems', body: 'database info' });
    const nodeB = await writeNode({ type: 'assertion', body: 'unrelated content here' });

    await db.insert(edges).values({
      sourceId: nodeA.id,
      targetId: nodeB.id,
      relation: 'related_to',
    });

    const results = await hybridSearch({
      query: 'database systems',
      embedding: MOCK_EMBEDDING,
      expandEdges: true,
    });

    const ids = results.map((r) => r.node.id);
    expect(ids).toContain(nodeA.id);
    expect(ids).toContain(nodeB.id);
  });

  test('each result has a positive score', async () => {
    await writeNode({ type: 'assertion', body: 'score verification test content' });

    const results = await hybridSearch({
      query: 'score verification',
      embedding: MOCK_EMBEDDING,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});
